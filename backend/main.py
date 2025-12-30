import os
import uuid
import shutil
import tempfile
import zipfile
import asyncio
import re
import subprocess
from pathlib import Path
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, File, UploadFile, HTTPException, Request, BackgroundTasks, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.enums import Resampling
from shapely.geometry import Polygon, MultiPolygon

# rio-tiler for dynamic COG XYZ tile generation
from rio_tiler.io import Reader as TilerReader
from rio_tiler.errors import TileOutsideBounds
from pyproj import Transformer

app = FastAPI(title="GIS Swipe Lab API", version="1.2.0")

# CORS configuration with exposed headers for Range requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Content-Length", "Accept-Ranges"],
)

# Paths
UPLOAD_DIR = Path("/app/uploads")
PROCESSED_DIR = Path("/app/processed")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

# Thread pool for CPU-intensive operations
executor = ThreadPoolExecutor(max_workers=2)

# Mount static files (for non-COG files like GeoJSON)
app.mount("/processed", StaticFiles(directory=str(PROCESSED_DIR)), name="processed")


# Request models
class LocalFileRequest(BaseModel):
    filename: str


def is_raster_file(filename: str) -> bool:
    """Check if file is a raster format"""
    return filename.lower().endswith(('.tif', '.tiff'))


def is_vector_file(filename: str) -> bool:
    """Check if file is a vector format"""
    return filename.lower().endswith(('.shp', '.geojson', '.json', '.zip'))


# ============================================================
# COG Streaming Endpoint with HTTP Range Request Support
# This properly returns 206 Partial Content for georaster streaming
# ============================================================
@app.api_route("/api/cog/{filename:path}", methods=["GET", "HEAD"])
async def get_cog_file(
    filename: str,
    request: Request,
    range: Optional[str] = Header(None)
):
    """
    Serve COG files with proper HTTP Range request support.
    Returns 206 Partial Content for Range requests, 200 OK otherwise.
    Also handles HEAD requests for file existence checks.
    """
    # Security: prevent path traversal
    if ".." in filename or filename.startswith("/"):
        raise HTTPException(status_code=400, detail="Invalid filename")
    
    file_path = PROCESSED_DIR / filename
    
    # Handle .ovr files (external overviews) - return 404 since we use internal overviews
    if filename.lower().endswith('.ovr'):
        raise HTTPException(status_code=404, detail="External overview not found (using internal overviews)")
    
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")
    
    if not file_path.suffix.lower() in ['.tif', '.tiff', '.pmtiles']:
        raise HTTPException(status_code=400, detail="Only TIF and PMTiles files are served via this endpoint")
    
    file_size = file_path.stat().st_size
    
    # Determine content type based on file extension
    if file_path.suffix.lower() == '.pmtiles':
        content_type = "application/octet-stream"
    else:
        content_type = "image/tiff"
    
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": content_type,
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    }
    
    # Handle Range request
    if range:
        # Parse Range header: "bytes=start-end" or "bytes=start-"
        range_match = re.match(r'bytes=(\d+)-(\d*)', range)
        if range_match:
            start = int(range_match.group(1))
            end_str = range_match.group(2)
            end = int(end_str) if end_str else file_size - 1
            
            # Clamp end to file size
            end = min(end, file_size - 1)
            
            if start > end or start >= file_size:
                raise HTTPException(status_code=416, detail="Range not satisfiable")
            
            content_length = end - start + 1
            
            # Read specific byte range
            def iter_file_range():
                with open(file_path, "rb") as f:
                    f.seek(start)
                    remaining = content_length
                    chunk_size = 64 * 1024  # 64KB chunks
                    while remaining > 0:
                        read_size = min(chunk_size, remaining)
                        data = f.read(read_size)
                        if not data:
                            break
                        remaining -= len(data)
                        yield data
            
            headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
            headers["Content-Length"] = str(content_length)
            
            return StreamingResponse(
                iter_file_range(),
                status_code=206,
                headers=headers,
                media_type="image/tiff"
            )
    
    # Handle HEAD request - return headers only
    if request.method == "HEAD":
        headers["Content-Length"] = str(file_size)
        return Response(
            content=None,
            status_code=200,
            headers=headers,
            media_type="image/tiff"
        )
    
    # GET without Range header - return full file with streaming
    def iter_file():
        with open(file_path, "rb") as f:
            chunk_size = 64 * 1024
            while True:
                data = f.read(chunk_size)
                if not data:
                    break
                yield data
    
    headers["Content-Length"] = str(file_size)
    
    return StreamingResponse(
        iter_file(),
        status_code=200,
        headers=headers,
        media_type=content_type
    )


# ============================================================
# Dynamic XYZ Tile Endpoint for COG files
# Uses rio-tiler to generate tiles on-the-fly for MapLibre
# ============================================================
@app.get("/api/tiles/{z}/{x}/{y}.png")
async def get_xyz_tile(z: int, x: int, y: int, url: str):
    """
    Generate XYZ tiles dynamically from a COG file.
    This offloads heavy tile generation to the server (GPU-independent),
    so the browser only needs to display pre-rendered PNG tiles.
    
    Args:
        z, x, y: Standard XYZ tile coordinates
        url: Filename of the COG in processed directory (e.g., "file.tif")
    """
    # Security: prevent path traversal
    if ".." in url or url.startswith("/"):
        raise HTTPException(status_code=400, detail="Invalid filename")
    
    file_path = (PROCESSED_DIR / url).absolute()
    
    if not file_path.exists():
        print(f"[ERROR] Tile file not found: {file_path}")
        raise HTTPException(status_code=404, detail=f"File not found: {url}")
    
    if not file_path.suffix.lower() in ['.tif', '.tiff']:
        raise HTTPException(status_code=400, detail="Only TIF files supported for tile generation")
    
    try:
        with TilerReader(str(file_path)) as src:
            img = src.tile(x, y, z)
            
            # Render to PNG with proper handling of nodata/alpha
            content = img.render(img_format="PNG")
            
            return Response(
                content=content,
                media_type="image/png",
                headers={
                    "Cache-Control": "public, max-age=3600",
                    "Access-Control-Allow-Origin": "*"
                }
            )
    except TileOutsideBounds:
        # Return transparent PNG for tiles outside the raster bounds
        # 1x1 transparent PNG
        transparent_png = bytes([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
            0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
            0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
            0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
            0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
        ])
        return Response(
            content=transparent_png,
            media_type="image/png",
            headers={
                "Cache-Control": "public, max-age=3600",
                "Access-Control-Allow-Origin": "*"
            }
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Tile generation error: {str(e)}")


@app.get("/api/tiles/info")
async def get_tile_info(url: str):
    """
    Get metadata about a COG file for proper map initialization.
    Returns bounds, min/max zoom, and other tile info.
    """
    import traceback
    
    if ".." in url or url.startswith("/"):
        raise HTTPException(status_code=400, detail="Invalid filename")
    
    file_path = (PROCESSED_DIR / url).absolute()
    
    print(f"[DEBUG] Tile info requested for: {url}")
    print(f"[DEBUG] Full path: {file_path}")
    print(f"[DEBUG] File exists: {file_path.exists()}")
    
    if not file_path.exists():
        # List available files for debugging
        available = [f.name for f in PROCESSED_DIR.iterdir() if f.suffix.lower() in ['.tif', '.tiff']]
        print(f"[DEBUG] Available TIF files: {available}")
        raise HTTPException(status_code=404, detail=f"File not found: {url}. Available: {available[:5]}")
    
    try:
        with TilerReader(str(file_path)) as src:
            # Get info
            info = src.info()
            
            # Explicitly get WGS84 bounds
            # src.bounds is usually WGS84 in rio-tiler Reader, 
            # but let's double check the CRS and reproject if needed.
            raw_bounds = src.dataset.bounds
            src_crs = src.dataset.crs
            
            if src_crs and src_crs != "EPSG:4326":
                try:
                    transformer = Transformer.from_crs(src_crs, "EPSG:4326", always_xy=True)
                    min_lon, min_lat = transformer.transform(raw_bounds.left, raw_bounds.bottom)
                    max_lon, max_lat = transformer.transform(raw_bounds.right, raw_bounds.top)
                    bounds = [min_lon, min_lat, max_lon, max_lat]
                    print(f"[DEBUG] Reprojected bounds from {src_crs} to EPSG:4326: {bounds}")
                except Exception as e:
                    print(f"[WARN] Reprojection failed, falling back to src.bounds: {e}")
                    bounds = src.bounds
            else:
                bounds = src.bounds

            return {
                "bounds": bounds,
                "minzoom": getattr(info, "minzoom", getattr(src, "minzoom", 0)),
                "maxzoom": getattr(info, "maxzoom", getattr(src, "maxzoom", 22)),
                "band_metadata": getattr(info, "band_metadata", []),
                "dtype": getattr(info, "dtype", "uint8"),
                "colorinterp": getattr(info, "colorinterp", None)
            }
    except Exception as e:
        print(f"[ERROR] Error reading COG info for {file_path}:")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error reading COG info: {str(e)}")


def convert_to_cog(input_path: Path, output_path: Path) -> None:
    """Convert raster to Cloud Optimized GeoTIFF with overviews for fast loading.
    Reprojects to EPSG:3857 (Web Mercator) for proper display in web maps.
    """
    from rasterio.warp import calculate_default_transform, reproject
    from rasterio.crs import CRS
    
    dst_crs = CRS.from_epsg(3857)  # Web Mercator for Leaflet
    
    with rasterio.open(input_path) as src:
        # Calculate transform for reprojection
        transform, width, height = calculate_default_transform(
            src.crs, dst_crs, src.width, src.height, *src.bounds
        )
        
        # Determine predictor based on data type
        dtype = src.dtypes[0]
        predictor = 2 if dtype in ['uint8', 'uint16', 'int16', 'uint32', 'int32'] else 3
        
        # Create profile for COG with optimized settings
        profile = src.profile.copy()
        profile.update(
            driver='GTiff',
            crs=dst_crs,
            transform=transform,
            width=width,
            height=height,
            tiled=True,
            blockxsize=512,
            blockysize=512,
            compress='DEFLATE',
            predictor=predictor,
            interleave='band',
            bigtiff='YES',
        )
        
        with rasterio.open(output_path, 'w', **profile) as dst:
            # Reproject each band
            for band_idx in range(1, src.count + 1):
                reproject(
                    source=rasterio.band(src, band_idx),
                    destination=rasterio.band(dst, band_idx),
                    src_transform=src.transform,
                    src_crs=src.crs,
                    dst_transform=transform,
                    dst_crs=dst_crs,
                    resampling=Resampling.bilinear
                )
            
            # Build comprehensive overviews for all zoom levels
            overview_levels = [2, 4, 8, 16, 32, 64]
            
            # Filter overview levels based on image size
            min_dim = min(width, height)
            valid_levels = [l for l in overview_levels if min_dim // l >= 64]
            
            if valid_levels:
                dst.build_overviews(valid_levels, Resampling.average)
                dst.update_tags(ns='rio_overview', resampling='average')


def polygon_to_ellipse(poly, num_points=64):
    """Convert a polygon to an elliptical approximation based on its MRR"""
    if poly.is_empty:
        return poly
        
    # Minimum rotated rectangle (MRR)
    mrr = poly.minimum_rotated_rectangle
    if mrr.geom_type != 'Polygon':
        return poly
        
    coords = list(mrr.exterior.coords)
    # MRR coords: p0, p1, p2, p3, p0
    p0 = np.array(coords[0])
    p1 = np.array(coords[1])
    p2 = np.array(coords[2])
    
    center = (p0 + p2) / 2
    v1 = p1 - p0
    v2 = p2 - p1
    
    len1 = np.linalg.norm(v1)
    len2 = np.linalg.norm(v2)
    
    # Semi-axes
    a = len1 / 2
    b = len2 / 2
    
    if a == 0 or b == 0:
        return poly
        
    # Directions
    u1 = v1 / len1
    u2 = v2 / len2
    
    # Generate ellipse points
    angles = np.linspace(0, 2*np.pi, num_points, endpoint=False)
    ellipse_points = []
    for angle in angles:
        # P = Center + a*cos(t)*u1 + b*sin(t)*u2
        p = center + a * np.cos(angle) * u1 + b * np.sin(angle) * u2
        ellipse_points.append(tuple(p))
        
    return Polygon(ellipse_points)


def transform_geometry_to_ellipse(geom):
    """Handle both Polygon and MultiPolygon for ellipse transformation"""
    from shapely.geometry import MultiPolygon
    
    if geom.geom_type == 'Polygon':
        return polygon_to_ellipse(geom)
    elif geom.geom_type == 'MultiPolygon':
        return MultiPolygon([polygon_to_ellipse(p) for p in geom.geoms])
    return geom


def convert_vector_to_geojson(input_path: Path, output_path: Path, original_filename: Optional[str] = None) -> None:
    """Convert vector file to GeoJSON with EPSG:4326.
    No simplification - preserve original geometry for accurate rendering.
    MapLibre + PMTiles handles large datasets efficiently via GPU.
    """
    gdf = gpd.read_file(input_path)
    
    # Reproject to EPSG:4326 if needed
    if gdf.crs is None:
        gdf.set_crs(epsg=4326, inplace=True)
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(epsg=4326)

    # Check if this is a CD layer (by filename or properties)
    file_lower = str(input_path).lower()
    orig_lower = str(original_filename).lower() if original_filename else ""
    # Detection keywords: cd, result, change, 결과, 변화
    is_cd_layer = any(kw in file_lower or kw in orig_lower for kw in ['cd', 'result', 'change', '결과', '변화', 'cd_results'])
    
    if is_cd_layer:
        print(f"[DEBUG] Generating ellipses for CD layer: {input_path.name}")
        # Apply ellipse transformation to all geometries
        gdf.geometry = gdf.geometry.apply(transform_geometry_to_ellipse)
        print(f"[DEBUG] Ellipse transformation complete for {len(gdf)} features")
    
    # Save as GeoJSON without simplification
    gdf.to_file(output_path, driver='GeoJSON')


def convert_geojson_to_pmtiles(geojson_path: Path, output_path: Path) -> None:
    """Convert GeoJSON to PMTiles using tippecanoe for fast vector tile rendering"""
    try:
        result = subprocess.run(
            [
                "tippecanoe",
                "-zg",  # Auto zoom levels based on data density
                "--drop-densest-as-needed",  # Minimal data loss while respecting tile size
                "--extend-zooms-if-still-dropping",  # Extend max zoom if needed
                "-o", str(output_path),
                "--force",  # Overwrite output if exists
                str(geojson_path)
            ],
            check=True,
            capture_output=True,
            text=True
        )
        print(f"[PMTiles] Conversion successful: {output_path}")
    except subprocess.CalledProcessError as e:
        print(f"[PMTiles] Conversion failed: {e.stderr}")
        raise RuntimeError(f"PMTiles conversion failed: {e.stderr}")


def extract_shapefile_from_zip(zip_path: Path, extract_dir: Path) -> Optional[Path]:
    """Extract shapefile from zip and return .shp path"""
    with zipfile.ZipFile(zip_path, 'r') as zip_ref:
        zip_ref.extractall(extract_dir)
    
    # Find .shp file
    for file in extract_dir.rglob('*.shp'):
        return file
    return None


async def stream_upload_to_disk(file: UploadFile, destination: Path, chunk_size: int = 1024 * 1024) -> None:
    """Stream upload file to disk in chunks (1MB default) to avoid memory issues"""
    with open(destination, "wb") as buffer:
        while True:
            chunk = await file.read(chunk_size)
            if not chunk:
                break
            buffer.write(chunk)


def process_file_sync(input_path: Path, filename: str, file_id: str, keep_source: bool = False) -> dict:
    """Synchronous file processing (runs in thread pool)
    
    Args:
        keep_source: If True, don't delete the source file after processing
    """
    original_name = Path(filename).stem
    
    try:
        if is_raster_file(filename):
            output_name = f"{original_name}_{file_id}.tif"
            output_path = PROCESSED_DIR / output_name
            convert_to_cog(input_path, output_path)
            
            # Clean up input file if it's in uploads directory (unless keep_source)
            if not keep_source and input_path.parent == UPLOAD_DIR:
                input_path.unlink(missing_ok=True)
            
            return {
                "success": True,
                "id": file_id,
                "name": original_name,
                "type": "raster",
                "url": f"/processed/{output_name}",
                "message": "Raster converted to COG successfully"
            }
            
        elif is_vector_file(filename):
            temp_dir = None
            actual_input = input_path
            
            # Handle zip files (shapefiles)
            if filename.lower().endswith('.zip'):
                temp_dir = tempfile.mkdtemp()
                extract_dir = Path(temp_dir) / "extracted"
                extract_dir.mkdir()
                shp_path = extract_shapefile_from_zip(input_path, extract_dir)
                if not shp_path:
                    if temp_dir:
                        shutil.rmtree(temp_dir, ignore_errors=True)
                    raise ValueError("No shapefile found in zip")
                actual_input = shp_path
            
            # Process vector
            output_name = f"{original_name}_{file_id}.geojson"
            output_path = PROCESSED_DIR / output_name
            convert_vector_to_geojson(actual_input, output_path, filename)
            
            # Convert to PMTiles for fast vector tile rendering
            pmtiles_name = f"{original_name}_{file_id}.pmtiles"
            pmtiles_path = PROCESSED_DIR / pmtiles_name
            pmtiles_url = None
            try:
                convert_geojson_to_pmtiles(output_path, pmtiles_path)
                pmtiles_url = f"/processed/{pmtiles_name}"
            except Exception as pmtiles_error:
                print(f"[PMTiles] Warning: Could not generate PMTiles: {pmtiles_error}")
                # Continue without PMTiles - fallback to GeoJSON
            
            # Clean up
            if temp_dir:
                shutil.rmtree(temp_dir, ignore_errors=True)
            if not keep_source and input_path.parent == UPLOAD_DIR:
                input_path.unlink(missing_ok=True)
            
            result = {
                "success": True,
                "id": file_id,
                "name": original_name,
                "type": "vector",
                "url": f"/processed/{output_name}",
                "message": "Vector converted successfully"
            }
            
            if pmtiles_url:
                result["pmtilesUrl"] = pmtiles_url
                result["message"] = "Vector converted to GeoJSON + PMTiles successfully"
            
            return result
        else:
            raise ValueError(f"Unsupported file format: {filename}")
            
    except Exception as e:
        raise e


@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "geo-swipe-lab-api"}


@app.get("/api/layers")
async def list_layers():
    """List all processed layers"""
    layers = []
    seen_ids = set()  # Track seen IDs to prevent duplicates
    
    for file in PROCESSED_DIR.iterdir():
        if file.is_file():
            # Skip PMTiles when there's a matching GeoJSON (same base name)
            if file.suffix.lower() == '.pmtiles':
                continue
                
            layer_type = "raster" if file.suffix.lower() in ['.tif', '.tiff'] else "vector"
            
            # Extract the UUID portion from filename (format: name_uuid.ext)
            # Use full stem as ID for uniqueness
            layer_id = file.stem
            
            # Skip if we've already seen this ID
            if layer_id in seen_ids:
                continue
            seen_ids.add(layer_id)
            
            # Check for PMTiles companion file
            pmtiles_path = PROCESSED_DIR / f"{file.stem}.pmtiles"
            pmtiles_url = f"/processed/{file.stem}.pmtiles" if pmtiles_path.exists() else None
            
            layer_data = {
                "id": layer_id,
                "name": file.stem.rsplit('_', 1)[0] if '_' in file.stem else file.stem,
                "type": layer_type,
                "url": f"/processed/{file.name}"
            }
            
            if pmtiles_url:
                layer_data["pmtilesUrl"] = pmtiles_url
            
            layers.append(layer_data)
    
    return {"layers": layers}


@app.get("/api/uploads")
async def list_uploads():
    """List files in uploads directory (for local file processing)"""
    files = []
    
    for file in UPLOAD_DIR.iterdir():
        if file.is_file():
            file_type = "raster" if is_raster_file(file.name) else "vector" if is_vector_file(file.name) else "unknown"
            files.append({
                "filename": file.name,
                "size_mb": round(file.stat().st_size / (1024 * 1024), 2),
                "type": file_type
            })
    
    return {"files": files}


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    Upload and process geospatial file with streaming support
    - Raster (TIF): Convert to COG
    - Vector (SHP/GeoJSON): Convert to EPSG:4326 GeoJSON
    - Supports large files via chunked streaming
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    
    # Generate unique ID - use full UUID to prevent collisions
    file_id = str(uuid.uuid4())
    
    # Stream file to uploads directory first
    input_path = UPLOAD_DIR / f"{file_id}_{file.filename}"
    
    try:
        # Stream upload to disk in chunks
        await stream_upload_to_disk(file, input_path)
        
        # Process in thread pool (CPU-intensive)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            executor,
            process_file_sync,
            input_path,
            file.filename,
            file_id
        )
        
        return JSONResponse(result)
        
    except Exception as e:
        # Clean up on error
        input_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Processing error: {str(e)}")


@app.post("/api/upload-local")
async def process_local_file(request: LocalFileRequest):
    """
    Process a file that's already in the uploads directory
    Use this for large files (>1GB) that were copied directly to ./uploads
    
    Example:
        curl -X POST http://localhost:8000/process-local \
             -H "Content-Type: application/json" \
             -d '{"filename": "large_raster.tif"}'
    """
    filename = request.filename
    input_path = UPLOAD_DIR / filename
    
    if not input_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"File '{filename}' not found in uploads directory. Available files: {[f.name for f in UPLOAD_DIR.iterdir() if f.is_file()]}"
        )
    
    if not (is_raster_file(filename) or is_vector_file(filename)):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format: {filename}. Supported: TIF, SHP (as zip), GeoJSON"
        )
    
    # Generate unique ID
    file_id = str(uuid.uuid4())[:8]
    
    try:
        # Process in thread pool (CPU-intensive)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            executor,
            lambda: process_file_sync(input_path, filename, file_id, keep_source=True)
        )
        
        return JSONResponse(result)
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Processing error: {str(e)}")


@app.delete("/api/layers/{layer_id}")
async def delete_layer(layer_id: str):
    """Delete a processed layer"""
    deleted = False
    for file in PROCESSED_DIR.iterdir():
        if file.stem.endswith(layer_id):
            file.unlink()
            deleted = True
            break
    
    if deleted:
        return {"success": True, "message": f"Layer {layer_id} deleted"}
    raise HTTPException(status_code=404, detail="Layer not found")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
