import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import parseGeoraster from 'georaster';
import GeoRasterLayer from 'georaster-layer-for-leaflet';

const API_BASE = '';

const uploadAxios = axios.create({
    timeout: 600000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
});

function App() {
    const mapRef = useRef(null);
    const mapInstanceRef = useRef(null);
    const layerObjectsRef = useRef({});
    const layerPanesRef = useRef({});
    const swipeRef = useRef(null);

    const [layers, setLayers] = useState([]);
    const [layerVisibility, setLayerVisibility] = useState({});
    const [swipeLayerId, setSwipeLayerId] = useState(null);
    const [swipePosition, setSwipePosition] = useState(50);
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [toasts, setToasts] = useState([]);
    const [fileDragging, setFileDragging] = useState(false);
    const [localFiles, setLocalFiles] = useState([]);
    const [showLocalFiles, setShowLocalFiles] = useState(false);
    const [draggedIdx, setDraggedIdx] = useState(null);
    const [loading, setLoading] = useState({});

    const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

    useEffect(() => {
        if (!mapRef.current || mapInstanceRef.current) return;

        const map = L.map(mapRef.current, {
            center: [37.5665, 126.9780],
            zoom: 10,
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OSM'
        }).addTo(map);

        mapInstanceRef.current = map;
        fetchLayers();

        return () => {
            map.remove();
            mapInstanceRef.current = null;
        };
    }, []);

    const toast = useCallback((msg, type = 'success') => {
        const id = Date.now();
        setToasts(p => [...p, { id, msg, type }]);
        setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3000);
    }, []);

    const fetchLayers = async () => {
        try {
            const res = await axios.get(`${API_BASE}/api/layers`);
            const list = res.data.layers || [];
            setLayers(list);
            const vis = {};
            list.forEach(l => { vis[l.id] = true; });
            setLayerVisibility(vis);
            for (let i = 0; i < list.length; i++) {
                await addLayer(list[i], i);
            }
        } catch (e) {
            console.error(e);
        }
    };

    const fetchLocalFiles = async () => {
        try {
            const res = await axios.get(`${API_BASE}/api/uploads`);
            setLocalFiles(res.data.files || []);
            setShowLocalFiles(true);
        } catch (e) {
            toast('Failed to fetch files', 'error');
        }
    };

    const processLocal = async (filename) => {
        setUploading(true);
        try {
            const res = await uploadAxios.post(`${API_BASE}/api/process-local`, { filename });
            const newLayer = { id: res.data.id, name: res.data.name, type: res.data.type, url: res.data.url };
            setLayers(p => [newLayer, ...p]);
            setLayerVisibility(p => ({ ...p, [newLayer.id]: true }));
            await addLayer(newLayer, 0);
            toast(`${newLayer.name} loaded!`);
            fetchLocalFiles();
        } catch (e) {
            toast(e.response?.data?.detail || 'Failed', 'error');
        } finally {
            setUploading(false);
        }
    };

    const handleUpload = async (files) => {
        if (!files?.length) return;
        const file = files[0];
        const fd = new FormData();
        fd.append('file', file);
        setUploading(true);
        setUploadProgress(0);
        try {
            const res = await uploadAxios.post(`${API_BASE}/api/upload`, fd, {
                headers: { 'Content-Type': 'multipart/form-data' },
                onUploadProgress: (e) => setUploadProgress(Math.round((e.loaded * 100) / e.total))
            });
            const newLayer = { id: res.data.id, name: res.data.name, type: res.data.type, url: res.data.url };
            setLayers(p => [newLayer, ...p]);
            setLayerVisibility(p => ({ ...p, [newLayer.id]: true }));
            await addLayer(newLayer, 0);
            toast(`${newLayer.name} uploaded!`);
        } catch (e) {
            toast(e.response?.data?.detail || 'Upload failed', 'error');
        } finally {
            setUploading(false);
            setUploadProgress(0);
        }
    };

    const getOrCreatePane = (layerId, zIndex) => {
        const map = mapInstanceRef.current;
        if (!map) return null;

        const paneName = `layer-${layerId}`;
        let pane = map.getPane(paneName);

        if (!pane) {
            pane = map.createPane(paneName);
        }

        pane.style.zIndex = 400 + zIndex;
        layerPanesRef.current[layerId] = pane;
        return paneName;
    };

    const addLayer = async (layer, orderIndex = 0) => {
        const map = mapInstanceRef.current;
        if (!map) return;

        if (layerObjectsRef.current[layer.id]) {
            map.removeLayer(layerObjectsRef.current[layer.id]);
        }

        setLoading(p => ({ ...p, [layer.id]: true }));

        try {
            const color = COLORS[layer.id.charCodeAt(0) % COLORS.length];
            const paneName = getOrCreatePane(layer.id, 100 - orderIndex);
            let leafletLayer;

            if (layer.type === 'vector') {
                const res = await fetch(`${API_BASE}${layer.url}`);
                const geojson = await res.json();

                leafletLayer = L.geoJSON(geojson, {
                    pane: paneName,
                    style: { color, weight: 2, opacity: 0.8, fillOpacity: 0.35 },
                    onEachFeature: (f, lyr) => {
                        if (f.properties && Object.keys(f.properties).length) {
                            const html = Object.entries(f.properties).slice(0, 6)
                                .map(([k, v]) => `<b>${k}:</b> ${v}`).join('<br>');
                            lyr.bindPopup(html);
                        }
                    }
                });

                leafletLayer.addTo(map);
                layerObjectsRef.current[layer.id] = leafletLayer;

                const bounds = leafletLayer.getBounds();
                if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50] });

            } else if (layer.type === 'raster') {
                const res = await fetch(`${API_BASE}${layer.url}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const arrayBuffer = await res.arrayBuffer();
                const georaster = await parseGeoraster(arrayBuffer);

                leafletLayer = new GeoRasterLayer({
                    georaster,
                    opacity: 0.85,
                    resolution: 128,
                    pane: paneName
                });

                leafletLayer.addTo(map);
                layerObjectsRef.current[layer.id] = leafletLayer;

                setTimeout(() => {
                    const bounds = leafletLayer.getBounds();
                    if (bounds) map.fitBounds(bounds, { padding: [50, 50] });
                }, 100);
            }
        } catch (e) {
            console.error(`Failed to load layer ${layer.name}:`, e);
            toast(`Failed to load ${layer.name}: ${e.message}`, 'error');
        } finally {
            setLoading(p => ({ ...p, [layer.id]: false }));
        }
    };

    const toggleVisibility = (id) => {
        const pane = layerPanesRef.current[id];
        if (!pane) return;

        const visible = layerVisibility[id];
        pane.style.display = visible ? 'none' : '';
        setLayerVisibility(p => ({ ...p, [id]: !visible }));
    };

    const deleteLayer = async (id) => {
        if (swipeLayerId === id) stopSwipe();
        try {
            await axios.delete(`${API_BASE}/api/layers/${id}`);
            const map = mapInstanceRef.current;
            if (layerObjectsRef.current[id]) {
                map.removeLayer(layerObjectsRef.current[id]);
                delete layerObjectsRef.current[id];
            }
            delete layerPanesRef.current[id];
            setLayers(p => p.filter(l => l.id !== id));
            setLayerVisibility(p => { const n = { ...p }; delete n[id]; return n; });
            toast('Deleted');
        } catch (e) {
            toast('Delete failed', 'error');
        }
    };

    const reorderLayers = (fromIdx, toIdx) => {
        if (fromIdx === toIdx) return;
        const arr = [...layers];
        const [item] = arr.splice(fromIdx, 1);
        arr.splice(toIdx, 0, item);
        setLayers(arr);

        arr.forEach((layer, idx) => {
            const pane = layerPanesRef.current[layer.id];
            if (pane) {
                pane.style.zIndex = 400 + (100 - idx);
            }
        });
    };

    // ===== SWIPE with real clipping =====
    const startSwipe = (id) => {
        const map = mapInstanceRef.current;
        const pane = layerPanesRef.current[id];

        if (!map || !pane) {
            console.error('Swipe: map or pane not found', { map: !!map, pane: !!pane });
            toast('Cannot start swipe - pane not found', 'error');
            return;
        }

        stopSwipe();

        const container = map.getContainer();
        const layerName = layers.find(l => l.id === id)?.name || id;

        // Create UI elements
        const divider = document.createElement('div');
        divider.id = 'swipe-divider';
        divider.style.cssText = `
      position: absolute;
      top: 0;
      left: 50%;
      width: 4px;
      height: 100%;
      background: linear-gradient(180deg, #3b82f6 0%, #10b981 100%);
      transform: translateX(-50%);
      z-index: 1000;
      cursor: ew-resize;
      pointer-events: auto;
      box-shadow: 0 0 10px rgba(59, 130, 246, 0.5);
    `;

        const handle = document.createElement('div');
        handle.id = 'swipe-handle';
        handle.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      width: 40px;
      height: 40px;
      background: white;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      cursor: ew-resize;
      pointer-events: auto;
      z-index: 1001;
      font-size: 18px;
      user-select: none;
    `;
        handle.textContent = '⇔';

        const label = document.createElement('div');
        label.id = 'swipe-label';
        label.style.cssText = `
      position: absolute;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.85);
      color: white;
      padding: 5px 12px;
      border-radius: 4px;
      font-size: 11px;
      z-index: 1002;
      pointer-events: none;
      white-space: nowrap;
    `;
        label.textContent = `Swipe: ${layerName}`;

        container.appendChild(divider);
        container.appendChild(handle);
        container.appendChild(label);

        // Track current percentage (closure-safe)
        let currentPct = 50;

        // Apply clip function - clips the PANE element
        const applyClip = (pct) => {
            currentPct = pct;

            // Update UI positions
            divider.style.left = `${pct}%`;
            handle.style.left = `${pct}%`;
            setSwipePosition(pct);

            // Calculate clip in pixels based on container width
            const containerWidth = container.offsetWidth;
            const clipX = (pct / 100) * containerWidth;

            // Use clip property (older but more compatible) 
            // clip: rect(top, right, bottom, left)
            // To show left portion: rect(0, clipX, containerHeight, 0)
            const containerHeight = container.offsetHeight;
            pane.style.clip = `rect(0px, ${clipX}px, ${containerHeight}px, 0px)`;
        };

        // Handle resize/move/zoom - update clip with current percentage
        const onMapChange = () => {
            applyClip(currentPct);
        };
        map.on('resize', onMapChange);
        map.on('move', onMapChange);
        map.on('zoom', onMapChange);
        map.on('moveend', onMapChange);
        map.on('zoomend', onMapChange);

        // Drag handling
        let dragging = false;

        const onMove = (e) => {
            if (!dragging) return;
            e.preventDefault();
            const x = e.touches ? e.touches[0].clientX : e.clientX;
            const rect = container.getBoundingClientRect();
            let pct = ((x - rect.left) / rect.width) * 100;
            pct = Math.max(5, Math.min(95, pct));
            applyClip(pct);
        };

        const onUp = () => {
            dragging = false;
            map.dragging.enable();
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
        };

        const onDown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragging = true;
            map.dragging.disable();
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onUp);
        };

        divider.addEventListener('mousedown', onDown);
        divider.addEventListener('touchstart', onDown, { passive: false });
        handle.addEventListener('mousedown', onDown);
        handle.addEventListener('touchstart', onDown, { passive: false });

        // Initial clip at 50%
        applyClip(50);

        swipeRef.current = {
            pane,
            cleanup: () => {
                divider.remove();
                handle.remove();
                label.remove();

                // Reset clip
                pane.style.clip = '';
                pane.style.clipPath = '';

                map.dragging.enable();
                map.off('resize', onMapChange);
                map.off('move', onMapChange);
                map.off('zoom', onMapChange);
                map.off('moveend', onMapChange);
                map.off('zoomend', onMapChange);
            }
        };

        setSwipeLayerId(id);
        toast('Drag handle to clip layer');
    };

    const stopSwipe = () => {
        if (swipeRef.current) {
            swipeRef.current.cleanup();
            swipeRef.current = null;
        }
        setSwipeLayerId(null);
        setSwipePosition(50);
    };

    return (
        <div className="map-container">
            <div id="map" ref={mapRef}></div>

            <div className="control-panel">
                <div className="card">
                    <div className="card-title">📤 Upload</div>
                    <div
                        className={`upload-area ${fileDragging ? 'active' : ''}`}
                        onDragOver={(e) => { e.preventDefault(); setFileDragging(true); }}
                        onDragLeave={() => setFileDragging(false)}
                        onDrop={(e) => { e.preventDefault(); setFileDragging(false); handleUpload(e.dataTransfer.files); }}
                        onClick={() => document.getElementById('file-input').click()}
                    >
                        <div>{uploading ? `${uploadProgress}%` : 'Drop / Click'}</div>
                        <small>TIF, GeoJSON, SHP(zip)</small>
                        <input id="file-input" type="file" hidden accept=".tif,.tiff,.geojson,.json,.zip"
                            onChange={(e) => handleUpload(e.target.files)} />
                    </div>
                    {uploading && <div className="progress"><div className="bar" style={{ width: `${uploadProgress}%` }}></div></div>}
                    <button className="btn" onClick={fetchLocalFiles} disabled={uploading}>📁 Local Files</button>
                </div>

                {showLocalFiles && (
                    <div className="card">
                        <div className="card-title">📂 Local <button className="close" onClick={() => setShowLocalFiles(false)}>×</button></div>
                        {localFiles.length === 0 ? <div className="empty">Empty</div> : (
                            <div className="list">
                                {localFiles.map((f, i) => (
                                    <div key={i} className="list-item">
                                        <span className={`badge ${f.type}`}>{f.type[0]}</span>
                                        <span className="name">{f.filename}</span>
                                        <span className="size">{f.size_mb}MB</span>
                                        <button className="btn small" onClick={() => processLocal(f.filename)} disabled={uploading}>Load</button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                <div className="card">
                    <div className="card-title">🗂 Layers ({layers.length}) <small>Top=Front</small></div>
                    {layers.length === 0 ? <div className="empty">No layers</div> : (
                        <div className="list">
                            {layers.map((layer, idx) => (
                                <div
                                    key={layer.id}
                                    className={`list-item ${draggedIdx === idx ? 'dragging' : ''} ${swipeLayerId === layer.id ? 'swiping' : ''}`}
                                    draggable
                                    onDragStart={() => setDraggedIdx(idx)}
                                    onDragOver={(e) => e.preventDefault()}
                                    onDrop={() => { reorderLayers(draggedIdx, idx); setDraggedIdx(null); }}
                                    onDragEnd={() => setDraggedIdx(null)}
                                >
                                    <span className="handle">⋮</span>
                                    <button className={`icon-btn ${layerVisibility[layer.id] ? '' : 'off'}`} onClick={() => toggleVisibility(layer.id)}>
                                        {layerVisibility[layer.id] ? '👁' : '—'}
                                    </button>
                                    <span className={`badge ${layer.type}`}>{layer.type === 'raster' ? 'R' : 'V'}</span>
                                    <span className="name">{loading[layer.id] ? '⏳' : ''}{layer.name}</span>
                                    <button
                                        className={`icon-btn swipe ${swipeLayerId === layer.id ? 'active' : ''}`}
                                        onClick={() => swipeLayerId === layer.id ? stopSwipe() : startSwipe(layer.id)}
                                        disabled={!layerVisibility[layer.id]}
                                    >↔</button>
                                    <button className="icon-btn del" onClick={() => deleteLayer(layer.id)}>×</button>
                                </div>
                            ))}
                        </div>
                    )}
                    {swipeLayerId && (
                        <div className="swipe-bar">
                            <b>{layers.find(l => l.id === swipeLayerId)?.name}</b> | {Math.round(swipePosition)}%
                            <button onClick={stopSwipe}>Stop</button>
                        </div>
                    )}
                </div>
            </div>

            <div className="toasts">
                {toasts.map(t => <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>)}
            </div>
        </div>
    );
}

export default App;
