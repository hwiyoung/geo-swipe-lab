import os
import uuid
import shutil
import tempfile
import zipfile
import asyncio
from pathlib import Path
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, File, UploadFile, HTTPException, Request, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import rasterio
from rasterio.io import MemoryFile
from rasterio.enums import Resampling
import geopandas as gpd

app = FastAPI(title="GIS Swipe Lab API", version="1.1.0")

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Paths
UPLOAD_DIR = Path("/app/uploads")
PROCESSED_DIR = Path("/app/processed")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

# Thread pool for CPU-intensive operations
executor = ThreadPoolExecutor(max_workers=2)

# Mount static files
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


def convert_to_cog(input_path: Path, output_path: Path) -> None:
    """Convert raster to Cloud Optimized GeoTIFF with memory-efficient windowed reading"""
    with rasterio.open(input_path) as src:
        # Read profile and update for COG
        profile = src.profile.copy()
        profile.update(
            driver='GTiff',
            tiled=True,
            blockxsize=512,
            blockysize=512,
            compress='LZW',
            interleave='band',
            bigtiff='YES'  # Support for large files
        )
        
        with rasterio.open(output_path, 'w', **profile) as dst:
            # Use windowed reading for memory efficiency
            for band_idx in range(1, src.count + 1):
                for _, window in src.block_windows(band_idx):
                    data = src.read(band_idx, window=window)
                    dst.write(data, band_idx, window=window)
            
            # Build overviews
            overview_levels = [2, 4, 8, 16]
            dst.build_overviews(overview_levels, Resampling.average)
            dst.update_tags(ns='rio_overview', resampling='average')


def convert_vector_to_geojson(input_path: Path, output_path: Path) -> None:
    """Convert vector file to GeoJSON with EPSG:4326 and optional simplification"""
    gdf = gpd.read_file(input_path)
    
    # Reproject to EPSG:4326 if needed
    if gdf.crs is None:
        gdf.set_crs(epsg=4326, inplace=True)
    elif gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(epsg=4326)
    
    # Simplify geometry for better performance if file is large
    # Use file size as proxy for complexity
    try:
        file_size_mb = input_path.stat().st_size / (1024 * 1024)
        if file_size_mb > 5:  # Simplify if larger than 5MB
            gdf['geometry'] = gdf.geometry.simplify(tolerance=0.0001, preserve_topology=True)
    except Exception:
        pass  # Skip simplification if it fails
    
    # Save as GeoJSON
    gdf.to_file(output_path, driver='GeoJSON')


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
            convert_vector_to_geojson(actual_input, output_path)
            
            # Clean up
            if temp_dir:
                shutil.rmtree(temp_dir, ignore_errors=True)
            if not keep_source and input_path.parent == UPLOAD_DIR:
                input_path.unlink(missing_ok=True)
            
            return {
                "success": True,
                "id": file_id,
                "name": original_name,
                "type": "vector",
                "url": f"/processed/{output_name}",
                "message": "Vector converted to GeoJSON (EPSG:4326) successfully"
            }
        else:
            raise ValueError(f"Unsupported file format: {filename}")
            
    except Exception as e:
        raise e


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "geo-swipe-lab-api"}


@app.get("/layers")
async def list_layers():
    """List all processed layers"""
    layers = []
    
    for file in PROCESSED_DIR.iterdir():
        if file.is_file():
            layer_type = "raster" if file.suffix.lower() in ['.tif', '.tiff'] else "vector"
            layers.append({
                "id": file.stem,
                "name": file.name,
                "type": layer_type,
                "url": f"/processed/{file.name}"
            })
    
    return {"layers": layers}


@app.get("/uploads")
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


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    Upload and process geospatial file with streaming support
    - Raster (TIF): Convert to COG
    - Vector (SHP/GeoJSON): Convert to EPSG:4326 GeoJSON
    - Supports large files via chunked streaming
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    
    # Generate unique ID
    file_id = str(uuid.uuid4())[:8]
    
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


@app.post("/process-local")
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


@app.delete("/layers/{layer_id}")
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
