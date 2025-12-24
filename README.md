# GIS Swipe Lab

Docker Compose 기반의 GIS 웹 애플리케이션입니다. TIF/SHP/GeoJSON 파일을 업로드하면 자동 변환 후 지도에서 비교할 수 있습니다.

## 🚀 Quick Start

```bash
# 시작
docker-compose up -d

# 종료
docker-compose down
```

- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:8000

## ✨ Features

### 📤 파일 업로드
- **래스터 (TIF)**: COG (Cloud Optimized GeoTIFF)로 자동 변환
- **벡터 (SHP/GeoJSON)**: EPSG:4326 GeoJSON으로 자동 변환
- 대용량 파일 스트리밍 업로드 지원 (청크 단위)

### 📁 로컬 파일 처리
대용량 파일(1GB+)은 `./uploads` 폴더에 직접 복사 후 처리:

```bash
# 1. 파일 복사
cp large_file.tif ./uploads/

# 2. 웹 UI에서 "Local Files" 클릭 후 "Load"
```

### 🗂 레이어 관리
- **가시성 토글**: 👁 아이콘 클릭
- **순서 변경**: 드래그 앤 드롭 (위 = 앞)
- **삭제**: × 버튼

### ↔ 스와이프 비교
레이어 옆 `↔` 버튼 클릭 → 핸들 드래그

## 🏗 Architecture

```
geo-swipe-lab/
├── docker-compose.yml
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── main.py          # FastAPI + GDAL
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── App.jsx      # React + Leaflet
├── uploads/             # 원본 파일 (git ignored)
└── processed/           # 변환된 파일 (git ignored)
```

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | 서비스 상태 |
| GET | `/layers` | 레이어 목록 |
| GET | `/uploads` | 업로드 폴더 파일 목록 |
| POST | `/upload` | 파일 업로드 및 변환 |
| POST | `/process-local` | 로컬 파일 변환 |
| DELETE | `/layers/{id}` | 레이어 삭제 |

## 🛠 Tech Stack

### Backend
- Python 3.11
- FastAPI + Uvicorn
- GDAL / Rasterio / GeoPandas

### Frontend
- React 18 + Vite
- Leaflet
- georaster-layer-for-leaflet

## 📝 Notes

- 래스터: BigTIFF 지원 (4GB+ 파일)
- 벡터: 5MB 이상 파일 자동 단순화
- 타임아웃: 10분 (대용량 파일용)
