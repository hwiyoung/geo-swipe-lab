# Geo Swipe Lab

A powerful GIS web application for comparing and analyzing geospatial data using a side-by-side swipe interface. Built with **MapLibre GL JS**, **FastAPI**, and **rio-tiler**.

## 🚀 Quick Start

1. **Clone and Run**:
   ```bash
   docker-compose up -d --build
   ```
2. **Access**:
   - **Interface**: [http://localhost:5173](http://localhost:5173) (or via Server IP)
   - **Backend API**: [http://localhost:8000/api/health](http://localhost:8000/api/health)

## ✨ Core Features

### 🗺️ High-Performance Mapping
- **MapLibre GL JS**: GPU-accelerated rendering for smooth interaction.
- **Dynamic Tile Generation**: TIF/COG files are served as XYZ tiles on-the-fly via **rio-tiler**, reducing bandwidth.
- **PMTiles Support**: Large vector datasets (SHP/GeoJSON) are converted to PMTiles for lightning-fast, serverless-style tile access.

### ↔️ Integrated Swipe Mode
- Compare two or more layers using a synchronized split-map interface.
- Layer stacking (Z-index) is maintained across both views.

### 📁 Smart Data Processing
- **Raster (TIF)**: Automatically converted to Cloud Optimized GeoTIFF (COG) with overviews.
- **Vector (SHP/GeoJSON)**: Automatically reprojected to EPSG:4326 and converted to PMTiles + GeoJSON fallback.
- **CD Ellipse Transformation**: Change Detection (CD) result layers are automatically transformed into clean elliptical approximations for better visual clarity.

### 🗂️ Advanced Layer Management
- **Drag-and-Drop Reordering**: Change layer stacking order with immediate map updates.
- **Loading Indicators**: Visual feedback for data processing and map rendering.
- **Local File Processing**: Load large datasets pre-staged in the `./uploads` directory.

## 🏗 Architecture

```
geo-swipe-lab/
├── docker-compose.yml
├── backend/
│   ├── main.py          # FastAPI + rio-tiler + GDAL
│   └── requirements.txt
├── frontend/
│   ├── src/App.jsx      # React + MapLibre GL JS
│   └── vite.config.js   # Proxy configuration
├── uploads/             # Source data (Git ignored)
└── processed/           # Processed COG/PMTiles (Git ignored)
```

## 🛠 Tech Stack

- **Frontend**: React 18, MapLibre GL JS, @hello-pangea/dnd, Axios.
- **Backend**: FastAPI, Rasterio, rio-tiler, GeoPandas, Tippecanoe.
- **DevOps**: Docker, Vite Proxy (seamless Localhost/Server IP access).

## 📝 Performance Tips

- Large rasters should be uploaded or placed in `./uploads` to be automatically converted to COG.
- Use the **Drag-and-Drop** panel to manage visual priority—vectors should generally stay above rasters.
