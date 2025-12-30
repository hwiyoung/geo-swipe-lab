import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as pmtiles from 'pmtiles';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import '@maplibre/maplibre-gl-compare/dist/maplibre-gl-compare.css';

// API base for normal requests (via Vite proxy)
const API_BASE = '';

// Backend URL for tiles and PMTiles (direct access)
const BACKEND_URL = window.location.origin;

const uploadAxios = axios.create({
    timeout: 600000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
});

// Default style settings
const DEFAULT_STYLES = {
    newBuild: '#ff0000',
    destroyed: '#00ff00',
    renewed: '#0000ff',
    baseMapBorder: '#800080',
    defaultBorder: '#800080',
    lineWeight: 2,
    fillOpacity: 0.25,
};

// Register PMTiles protocol globally
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

function App() {
    const mapContainerRef = useRef(null);
    const beforeMapContainerRef = useRef(null);
    const afterMapContainerRef = useRef(null);
    const mapRef = useRef(null);
    const beforeMapRef = useRef(null);
    const afterMapRef = useRef(null);
    const compareRef = useRef(null);
    const fpsRef = useRef({ frameCount: 0, lastTime: performance.now(), rafId: null });

    const [layers, setLayers] = useState([]);
    const [layerVisibility, setLayerVisibility] = useState({});
    const [uploading, setUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [toasts, setToasts] = useState([]);
    const [fileDragging, setFileDragging] = useState(false);
    const [localFiles, setLocalFiles] = useState([]);
    const [showLocalFiles, setShowLocalFiles] = useState(false);
    const [loading, setLoading] = useState({});

    // Style editor state
    const [styleSettings, setStyleSettings] = useState(DEFAULT_STYLES);
    const [showStyleEditor, setShowStyleEditor] = useState(false);

    // FPS meter state
    const [fps, setFps] = useState(0);

    // Swipe mode state
    const [swipeLayerId, setSwipeLayerId] = useState(null);
    const [sliderValue, setSliderValue] = useState(50);

    // FPS meter using requestAnimationFrame
    useEffect(() => {
        const updateFps = () => {
            fpsRef.current.frameCount++;
            const now = performance.now();
            if (now - fpsRef.current.lastTime >= 1000) {
                setFps(fpsRef.current.frameCount);
                fpsRef.current.frameCount = 0;
                fpsRef.current.lastTime = now;
            }
            fpsRef.current.rafId = requestAnimationFrame(updateFps);
        };
        fpsRef.current.rafId = requestAnimationFrame(updateFps);
        return () => {
            if (fpsRef.current.rafId) {
                cancelAnimationFrame(fpsRef.current.rafId);
            }
        };
    }, []);

    // Initialize map
    useEffect(() => {
        if (!mapContainerRef.current || mapRef.current) return;

        const map = new maplibregl.Map({
            container: mapContainerRef.current,
            style: {
                version: 8,
                sources: {
                    'osm': {
                        type: 'raster',
                        tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png', 'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png', 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'],
                        tileSize: 256,
                        attribution: '© OpenStreetMap'
                    }
                },
                layers: [{
                    id: 'osm-layer',
                    type: 'raster',
                    source: 'osm',
                    minzoom: 0,
                    maxzoom: 19
                }]
            },
            center: [126.9780, 37.5665],
            zoom: 10
        });

        map.addControl(new maplibregl.NavigationControl(), 'top-left');

        map.on('load', () => {
            mapRef.current = map;
            fetchLayers();
        });

        // Debug: Log properties on click
        map.on('click', (e) => {
            const features = map.queryRenderedFeatures(e.point);
            if (features.length > 0) {
                console.log('[DEBUG] Clicked features:', features.map(f => f.properties));
            }
        });

        return () => {
            if (mapRef.current) {
                mapRef.current.remove();
                mapRef.current = null;
            }
        };
    }, []);

    // Update map layer styles when settings change
    useEffect(() => {
        const updateMapStyles = (map) => {
            if (!map || !map.isStyleLoaded()) return;
            layers.forEach(layer => {
                const fillId = `fill-${layer.id}`;
                const lineId = `line-${layer.id}`;
                const rasterId = `raster-${layer.id}`;

                // Handle Vector (Fill)
                if (map.getLayer(fillId)) {
                    map.setPaintProperty(fillId, 'fill-opacity', styleSettings.fillOpacity);
                    map.setPaintProperty(fillId, 'fill-color', getColorExpression(layer.name));
                }
                // Handle Vector (Line)
                if (map.getLayer(lineId)) {
                    map.setPaintProperty(lineId, 'line-width', styleSettings.lineWeight);
                    map.setPaintProperty(lineId, 'line-color', getColorExpression(layer.name));
                }
                // Handle Raster
                if (map.getLayer(rasterId)) {
                    map.setPaintProperty(rasterId, 'raster-opacity', 0.85);
                }
            });
        };

        updateMapStyles(mapRef.current);
        updateMapStyles(beforeMapRef.current);
        updateMapStyles(afterMapRef.current);
    }, [styleSettings, layers, swipeLayerId]);

    // Handle swipe mode setup (Manual Synchronization)
    useEffect(() => {
        if (!swipeLayerId || !beforeMapContainerRef.current || !afterMapContainerRef.current) return;

        const commonStyle = {
            version: 8,
            sources: {
                'osm': {
                    type: 'raster',
                    tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png', 'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png'],
                    tileSize: 256
                }
            },
            layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
        };

        const beforeMap = new maplibregl.Map({
            container: beforeMapContainerRef.current,
            style: commonStyle,
            center: mapRef.current?.getCenter() || [126.9780, 37.5665],
            zoom: mapRef.current?.getZoom() || 10
        });

        const afterMap = new maplibregl.Map({
            container: afterMapContainerRef.current,
            style: commonStyle,
            center: mapRef.current?.getCenter() || [126.9780, 37.5665],
            zoom: mapRef.current?.getZoom() || 10
        });

        beforeMapRef.current = beforeMap;
        afterMapRef.current = afterMap;

        // Manual Synchronization with loop protection
        const onMove = (master, slave) => {
            if (!master.isMoving()) return;
            slave.jumpTo({
                center: master.getCenter(),
                zoom: master.getZoom(),
                bearing: master.getBearing(),
                pitch: master.getPitch()
            });
        };

        beforeMap.on('move', () => onMove(beforeMap, afterMap));
        afterMap.on('move', () => onMove(afterMap, beforeMap));

        // Add layers: 
        // afterMap (Bottom): All visible layers EXCEPT the swiped one
        // beforeMap (Top): All visible layers INCLUDING the swiped one
        const syncLayers = async () => {
            const visibleLayers = layers.filter(l => layerVisibility[l.id]);

            const backgroundLayers = visibleLayers.filter(l => l.id !== swipeLayerId);
            for (const l of backgroundLayers) {
                await addLayerToSpecificMap(afterMap, l);
                await addLayerToSpecificMap(beforeMap, l);
            }

            const swipedLayer = layers.find(l => l.id === swipeLayerId);
            if (swipedLayer) await addLayerToSpecificMap(beforeMap, swipedLayer);

            // Force correct stack order on both maps
            reorderMapLayers(visibleLayers, beforeMap);
            reorderMapLayers(backgroundLayers, afterMap);
        };

        beforeMap.on('load', syncLayers);
        afterMap.on('load', syncLayers);

        return () => {
            if (beforeMapRef.current) beforeMapRef.current.remove();
            if (afterMapRef.current) afterMapRef.current.remove();
        };
    }, [swipeLayerId]);

    const addLayerToSpecificMap = async (targetMap, layer) => {
        if (!targetMap) return;
        // Simplified version of addLayerToMap for compare maps
        if (layer.type === 'vector' && layer.pmtilesUrl) {
            const sourceUrl = `pmtiles://${BACKEND_URL}/api/cog/${layer.pmtilesUrl.replace('/processed/', '')}`;
            const sourceId = `source-${layer.id}`;
            const fillId = `fill-${layer.id}`;
            const lineId = `line-${layer.id}`;

            if (!targetMap.getSource(sourceId)) {
                targetMap.addSource(sourceId, { type: 'vector', url: sourceUrl });
            }

            // Try to get source layer name
            let sourceLayer = 'default';
            try {
                const pmtilesFilename = layer.pmtilesUrl.replace('/processed/', '');
                const pmtilesFullUrl = `${BACKEND_URL}/api/cog/${pmtilesFilename}`;
                const p = new pmtiles.PMTiles(pmtilesFullUrl);
                const metadata = await p.getMetadata();
                sourceLayer = metadata?.vector_layers?.[0]?.id || 'default';
            } catch (e) {
                console.warn('[Compare] PMTiles metadata fetch failed:', e);
            }

            if (!targetMap.getLayer(fillId)) {
                targetMap.addLayer({
                    id: fillId, type: 'fill', source: sourceId, 'source-layer': sourceLayer,
                    paint: { 'fill-color': getColorExpression(layer.name), 'fill-opacity': styleSettings.fillOpacity }
                });
            }
            if (!targetMap.getLayer(lineId)) {
                targetMap.addLayer({
                    id: lineId, type: 'line', source: sourceId, 'source-layer': sourceLayer,
                    paint: { 'line-color': getColorExpression(layer.name), 'line-width': styleSettings.lineWeight }
                });
            }
        } else if (layer.type === 'raster') {
            const sourceId = `source-${layer.id}`;
            const layerId = `raster-${layer.id}`;
            const filename = layer.url.replace('/processed/', '');

            try {
                const infoRes = await axios.get(`${BACKEND_URL}/api/tiles/info?url=${filename}`);
                const info = infoRes.data;

                if (!targetMap.getSource(sourceId)) {
                    targetMap.addSource(sourceId, {
                        type: 'raster',
                        tiles: [`${BACKEND_URL}/api/tiles/{z}/{x}/{y}.png?url=${filename}`],
                        tileSize: 256,
                        bounds: info.bounds,
                        minzoom: info.minzoom || 0,
                        maxzoom: info.maxzoom || 22
                    });
                }

                if (!targetMap.getLayer(layerId)) {
                    targetMap.addLayer({
                        id: layerId,
                        type: 'raster',
                        source: sourceId,
                        paint: { 'raster-opacity': 0.85 }
                    });
                }
            } catch (e) {
                console.warn('[Compare] Failed to add raster:', e);
            }
        }
    };

    const getColorExpression = (layerName) => {
        const ln = layerName.toLowerCase();
        const isCD = ln.includes('cd') || ln.includes('change') || ln.includes('결과') || ln.includes('result');
        if (!isCD) return styleSettings.baseMapBorder;

        // Helper to get normalized (lowercase) string value of a property
        const getNorm = (prop) => ['downcase', ['coalesce', ['to-string', ['get', prop]], '']];

        return [
            'case',
            ['any',
                ['in', '신축', getNorm('class_name')], ['in', 'new', getNorm('class_name')], ['in', 'added', getNorm('class_name')],
                ['in', '신축', getNorm('class')], ['in', 'new', getNorm('class')], ['in', 'added', getNorm('class')],
                ['in', '신축', getNorm('cls')], ['in', 'new', getNorm('cls')], ['in', 'added', getNorm('cls')]
            ], styleSettings.newBuild,
            ['any',
                ['in', '소멸', getNorm('class_name')], ['in', 'demolished', getNorm('class_name')], ['in', 'deleted', getNorm('class_name')],
                ['in', '소멸', getNorm('class')], ['in', 'demolished', getNorm('class')], ['in', 'deleted', getNorm('class')],
                ['in', '소멸', getNorm('cls')], ['in', 'demolished', getNorm('cls')], ['in', 'deleted', getNorm('cls')]
            ], styleSettings.destroyed,
            ['any',
                ['in', '갱신', getNorm('class_name')], ['in', 'updated', getNorm('class_name')], ['in', 'changed', getNorm('class_name')],
                ['in', '갱신', getNorm('class')], ['in', 'updated', getNorm('class')], ['in', 'changed', getNorm('class')],
                ['in', '갱신', getNorm('cls')], ['in', 'updated', getNorm('cls')], ['in', 'changed', getNorm('cls')]
            ], styleSettings.renewed,
            styleSettings.baseMapBorder
        ];
    };

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
            for (const layer of list) {
                await addLayerToMap(layer);
            }
            reorderMapLayers(list);
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
            const res = await uploadAxios.post(`${API_BASE}/api/upload-local`, { filename });
            const newLayer = {
                id: res.data.id,
                name: res.data.name,
                type: res.data.type,
                url: res.data.url,
                pmtilesUrl: res.data.pmtilesUrl || null
            };
            // Prevent duplicate layers
            setLayers(prev => {
                if (prev.some(layer => layer.id === newLayer.id)) {
                    console.warn('Duplicate layer ignored:', newLayer.id);
                    return prev;
                }
                return [newLayer, ...prev];
            });
            setLayerVisibility(p => ({ ...p, [newLayer.id]: true }));
            await addLayerToMap(newLayer);
            reorderMapLayers([newLayer, ...layers]);
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
            const newLayer = {
                id: res.data.id,
                name: res.data.name,
                type: res.data.type,
                url: res.data.url,
                pmtilesUrl: res.data.pmtilesUrl || null
            };
            // Prevent duplicate layers
            setLayers(prev => {
                if (prev.some(layer => layer.id === newLayer.id)) {
                    console.warn('Duplicate layer ignored:', newLayer.id);
                    return prev;
                }
                return [newLayer, ...prev];
            });
            setLayerVisibility(p => ({ ...p, [newLayer.id]: true }));
            await addLayerToMap(newLayer);
            reorderMapLayers([newLayer, ...layers]);
            toast(`${newLayer.name} uploaded!`);
        } catch (e) {
            toast(e.response?.data?.detail || 'Upload failed', 'error');
        } finally {
            setUploading(false);
            setUploadProgress(0);
        }
    };

    // Get color based on feature properties for vector tiles
    const getFeatureColor = (layerName, properties) => {
        const layerNameLower = layerName.toLowerCase();
        const isChangeDetection = layerNameLower.includes('cd') ||
            layerNameLower.includes('change') ||
            layerNameLower.includes('결과') ||
            layerNameLower.includes('result');

        if (!isChangeDetection) return styleSettings.baseMapBorder;

        const className = properties?.class_name ||
            properties?.class ||
            properties?.type ||
            properties?.category ||
            properties?.cd_type ||
            properties?.change_type || '';

        const classLower = String(className).toLowerCase();

        if (classLower.includes('new') || classLower.includes('신축') || classLower.includes('added')) {
            return styleSettings.newBuild;
        }
        if (classLower.includes('demolished') || classLower.includes('소멸') ||
            classLower.includes('deleted') || classLower.includes('removed')) {
            return styleSettings.destroyed;
        }
        if (classLower.includes('updated') || classLower.includes('갱신') ||
            classLower.includes('changed') || classLower.includes('modified')) {
            return styleSettings.renewed;
        }
        return styleSettings.defaultBorder;
    };

    const addLayerToMap = async (layer) => {
        const map = mapRef.current;
        if (!map) return;

        setLoading(p => ({ ...p, [layer.id]: true }));

        try {
            if (layer.type === 'vector') {
                // Use PMTiles if available
                if (layer.pmtilesUrl) {
                    const pmtilesFilename = layer.pmtilesUrl.replace('/processed/', '');
                    const pmtilesFullUrl = `${BACKEND_URL}/api/cog/${pmtilesFilename}`;
                    const sourceUrl = `pmtiles://${BACKEND_URL}/api/cog/${pmtilesFilename}`;

                    const sourceId = `source-${layer.id}`;
                    const fillLayerId = `fill-${layer.id}`;
                    const lineLayerId = `line-${layer.id}`;

                    // Fetch PMTiles metadata to get source-layer name
                    let sourceLayerName = 'default';
                    try {
                        const p = new pmtiles.PMTiles(pmtilesFullUrl);
                        const header = await p.getHeader();
                        const metadata = await p.getMetadata();

                        console.log('[PMTiles] Header:', header);
                        console.log('[PMTiles] Metadata:', metadata);

                        // Get source layer name from vector_layers
                        if (metadata?.vector_layers && metadata.vector_layers.length > 0) {
                            sourceLayerName = metadata.vector_layers[0].id;
                            console.log('[PMTiles] Using source-layer:', sourceLayerName);
                        } else if (metadata?.tilestats?.layers && metadata.tilestats.layers.length > 0) {
                            sourceLayerName = metadata.tilestats.layers[0].layer;
                            console.log('[PMTiles] Using source-layer from tilestats:', sourceLayerName);
                        }
                    } catch (metaError) {
                        console.warn('[PMTiles] Could not fetch metadata:', metaError);
                        // Try common layer names
                        sourceLayerName = layer.name || 'default';
                    }

                    // Add PMTiles source
                    if (!map.getSource(sourceId)) {
                        map.addSource(sourceId, {
                            type: 'vector',
                            url: sourceUrl
                        });
                    }

                    // Wait for source to be ready
                    await new Promise(resolve => setTimeout(resolve, 300));

                    // Add fill layer
                    if (!map.getLayer(fillLayerId)) {
                        try {
                            map.addLayer({
                                id: fillLayerId,
                                type: 'fill',
                                source: sourceId,
                                'source-layer': sourceLayerName,
                                paint: {
                                    'fill-color': getColorExpression(layer.name),
                                    'fill-opacity': styleSettings.fillOpacity
                                }
                            });
                        } catch (e) {
                            console.warn('[PMTiles] Fill layer error:', e.message);
                        }
                    }

                    // Add line layer
                    if (!map.getLayer(lineLayerId)) {
                        try {
                            map.addLayer({
                                id: lineLayerId,
                                type: 'line',
                                source: sourceId,
                                'source-layer': sourceLayerName,
                                paint: {
                                    'line-color': getColorExpression(layer.name),
                                    'line-width': styleSettings.lineWeight
                                }
                            });
                        } catch (e) {
                            console.warn('[PMTiles] Line layer error:', e.message);
                        }
                    }

                    // Get bounds from GeoJSON fallback
                    try {
                        const res = await fetch(`${API_BASE}${layer.url}`);
                        const geojson = await res.json();
                        if (geojson.features?.length) {
                            const bounds = new maplibregl.LngLatBounds();
                            geojson.features.forEach(f => {
                                if (f.geometry?.coordinates) {
                                    const coords = f.geometry.coordinates.flat(3);
                                    for (let i = 0; i < coords.length; i += 2) {
                                        if (typeof coords[i] === 'number' && typeof coords[i + 1] === 'number') {
                                            bounds.extend([coords[i], coords[i + 1]]);
                                        }
                                    }
                                }
                            });
                            if (!bounds.isEmpty()) {
                                map.fitBounds(bounds, { padding: 50 });
                            }
                        }
                    } catch (e) {
                        console.warn('Could not get bounds from GeoJSON:', e);
                    }

                    console.log('[PMTiles] Vector layer added:', layer.id);

                } else {
                    // Fallback to GeoJSON
                    const res = await fetch(`${API_BASE}${layer.url}`);
                    const geojson = await res.json();

                    const sourceId = `source-${layer.id}`;
                    const fillLayerId = `fill-${layer.id}`;
                    const lineLayerId = `line-${layer.id}`;

                    if (!map.getSource(sourceId)) {
                        map.addSource(sourceId, {
                            type: 'geojson',
                            data: geojson
                        });
                    }

                    if (!map.getLayer(fillLayerId)) {
                        map.addLayer({
                            id: fillLayerId,
                            type: 'fill',
                            source: sourceId,
                            paint: {
                                'fill-color': getColorExpression(layer.name),
                                'fill-opacity': styleSettings.fillOpacity
                            }
                        });
                    }

                    if (!map.getLayer(lineLayerId)) {
                        map.addLayer({
                            id: lineLayerId,
                            type: 'line',
                            source: sourceId,
                            paint: {
                                'line-color': getColorExpression(layer.name),
                                'line-width': styleSettings.lineWeight
                            }
                        });
                    }

                    // Fit bounds
                    if (geojson.features?.length) {
                        const bounds = new maplibregl.LngLatBounds();
                        geojson.features.forEach(f => {
                            if (f.geometry?.coordinates) {
                                const coords = f.geometry.coordinates.flat(3);
                                for (let i = 0; i < coords.length; i += 2) {
                                    if (typeof coords[i] === 'number' && typeof coords[i + 1] === 'number') {
                                        bounds.extend([coords[i], coords[i + 1]]);
                                    }
                                }
                            }
                        });
                        if (!bounds.isEmpty()) {
                            map.fitBounds(bounds, { padding: 50 });
                        }
                    }
                }

            } else if (layer.type === 'raster') {
                // Use dynamic XYZ tiles from rio-tiler
                const filename = layer.url.replace('/processed/', '');
                const sourceId = `source-${layer.id}`;
                const layerId = `raster-${layer.id}`;

                // Get tile info for bounds
                try {
                    const infoRes = await axios.get(`${BACKEND_URL}/api/tiles/info?url=${filename}`);
                    const info = infoRes.data;

                    if (!map.getSource(sourceId)) {
                        map.addSource(sourceId, {
                            type: 'raster',
                            tiles: [`${BACKEND_URL}/api/tiles/{z}/{x}/{y}.png?url=${filename}`],
                            tileSize: 256,
                            bounds: info.bounds,
                            minzoom: info.minzoom || 0,
                            maxzoom: info.maxzoom || 22
                        });
                    }

                    if (!map.getLayer(layerId)) {
                        map.addLayer({
                            id: layerId,
                            type: 'raster',
                            source: sourceId,
                            paint: {
                                'raster-opacity': 0.85
                            }
                        });
                    }

                    // Fit to bounds with validation
                    if (info.bounds && info.bounds.length === 4) {
                        const [minlng, minlat, maxlng, maxlat] = info.bounds;
                        // Basic validation: lat must be between -90 and 90, lng between -180 and 180
                        if (Math.abs(minlat) <= 90 && Math.abs(maxlat) <= 90 &&
                            Math.abs(minlng) <= 180 && Math.abs(maxlng) <= 180) {
                            map.fitBounds([
                                [minlng, minlat],
                                [maxlng, maxlat]
                            ], { padding: 50 });
                        } else {
                            console.warn('[XYZ Tiles] Invalid LngLat bounds, skipping fitBounds:', info.bounds);
                        }
                    }

                    console.log('[XYZ Tiles] Raster layer added:', layer.id);

                } catch (e) {
                    console.error('[XYZ Tiles] Failed to add raster:', e);
                    toast(`Failed to load raster: ${e.message}`, 'error');
                }
            }
        } catch (e) {
            console.error(`Failed to load layer ${layer.name}:`, e);
            toast(`Failed to load ${layer.name}: ${e.message}`, 'error');
        } finally {
            setLoading(p => ({ ...p, [layer.id]: false }));
        }
    };

    const toggleVisibility = (id) => {
        const map = mapRef.current;
        if (!map) return;

        const visible = layerVisibility[id];
        const newVisibility = visible ? 'none' : 'visible';

        // Toggle all layers for this source
        const fillLayerId = `fill-${id}`;
        const lineLayerId = `line-${id}`;
        const rasterLayerId = `raster-${id}`;

        [fillLayerId, lineLayerId, rasterLayerId].forEach(layerId => {
            if (map.getLayer(layerId)) {
                map.setLayoutProperty(layerId, 'visibility', newVisibility);
            }
        });

        setLayerVisibility(p => ({ ...p, [id]: !visible }));
    };

    const deleteLayer = async (id) => {
        try {
            await axios.delete(`${API_BASE}/api/layers/${id}`);
            const map = mapRef.current;

            // Remove layers and source
            const fillLayerId = `fill-${id}`;
            const lineLayerId = `line-${id}`;
            const rasterLayerId = `raster-${id}`;
            const sourceId = `source-${id}`;

            [fillLayerId, lineLayerId, rasterLayerId].forEach(layerId => {
                if (map.getLayer(layerId)) {
                    map.removeLayer(layerId);
                }
            });

            if (map.getSource(sourceId)) {
                map.removeSource(sourceId);
            }

            setLayers(p => p.filter(l => l.id !== id));
            setLayerVisibility(p => { const n = { ...p }; delete n[id]; return n; });
            toast('Deleted');
        } catch (e) {
            toast('Delete failed', 'error');
        }
    };

    // Handle style setting changes
    const handleStyleChange = (key, value) => {
        setStyleSettings(prev => ({ ...prev, [key]: value }));
    };

    // Get FPS color based on performance
    const getFpsColor = () => {
        if (fps >= 50) return '#00ff00';
        if (fps >= 30) return '#ffff00';
        return '#ff0000';
    };

    // Start/Stop Swipe
    const toggleSwipe = (id) => {
        if (swipeLayerId === id) {
            setSwipeLayerId(null);
        } else {
            setSwipeLayerId(id);
        }
    };

    const reorderMapLayers = (newLayersList, specificMap = null) => {
        const map = specificMap || mapRef.current;
        if (!map) return;

        // MapLibre moveLayer: target layer is placed BEFORE the reference layer
        // In our list, index 0 is TOP (drawn last).
        [...newLayersList].reverse().forEach(l => {
            const fillId = `fill-${l.id}`;
            const lineId = `line-${l.id}`;
            const rasterId = `raster-${l.id}`;
            [fillId, lineId, rasterId].forEach(lid => {
                if (map.getLayer(lid)) map.moveLayer(lid);
            });
        });
    };

    const handleDragEnd = (result) => {
        if (!result.destination) return;

        const reordered = Array.from(layers);
        const [removed] = reordered.splice(result.source.index, 1);
        reordered.splice(result.destination.index, 0, removed);

        setLayers(reordered);
        reorderMapLayers(reordered);
    };

    const moveLayer = (id, direction) => {
        const index = layers.findIndex(l => l.id === id);
        if (index < 0) return;

        const newIndex = direction === 'up' ? index - 1 : index + 1;
        if (newIndex < 0 || newIndex >= layers.length) return;

        const newLayers = [...layers];
        const [moved] = newLayers.splice(index, 1);
        newLayers.splice(newIndex, 0, moved);
        setLayers(newLayers);
        reorderMapLayers(newLayers);
    };

    const stopSwipe = () => {
        setSwipeLayerId(null);
    };

    return (
        <div className="map-container">
            {!swipeLayerId ? (
                <div id="map" ref={mapContainerRef}></div>
            ) : (
                <div className="compare-wrapper">
                    <div id="before-map" ref={beforeMapContainerRef} style={{ clipPath: `inset(0 ${100 - sliderValue}% 0 0)` }}></div>
                    <div id="after-map" ref={afterMapContainerRef}></div>

                    <div className="compare-label label-before">
                        ⬅ {layers.find(l => l.id === swipeLayerId)?.name} (Swipe Content)
                    </div>
                    <div className="compare-label label-after">
                        Background ➡
                    </div>

                    <div className="compare-slider-wrapper">
                        <input
                            type="range"
                            className="compare-slider-custom"
                            min="0"
                            max="100"
                            value={sliderValue}
                            onChange={(e) => setSliderValue(parseInt(e.target.value))}
                        />
                        <div className="compare-handle" style={{ left: `${sliderValue}%` }}></div>
                    </div>
                    <button className="btn small stop-btn swipe-stop" onClick={stopSwipe}>Stop Swipe</button>
                </div>
            )}

            {/* FPS Meter */}
            <div className="fps-meter" style={{ color: getFpsColor() }}>
                {fps} FPS
            </div>

            {/* Loading Overlay */}
            {Object.values(loading).some(v => v) && (
                <div className="layer-loading-overlay">
                    <div className="spinner"></div>
                </div>
            )}

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
                    <div className="card-title">
                        🗂 Layers ({layers.length})
                    </div>
                    {layers.length === 0 ? <div className="empty">No layers</div> : (
                        <DragDropContext onDragEnd={handleDragEnd}>
                            <Droppable droppableId="layers-list">
                                {(provided) => (
                                    <div
                                        className="list"
                                        {...provided.droppableProps}
                                        ref={provided.innerRef}
                                    >
                                        {layers.map((layer, index) => (
                                            <Draggable key={layer.id} draggableId={layer.id} index={index}>
                                                {(provided, snapshot) => (
                                                    <div
                                                        ref={provided.innerRef}
                                                        {...provided.draggableProps}
                                                        {...provided.dragHandleProps}
                                                        className={`list-item ${swipeLayerId === layer.id ? 'swiping' : ''} ${snapshot.isDragging ? 'dragging' : ''}`}
                                                    >
                                                        <button
                                                            className={`icon-btn ${layerVisibility[layer.id] ? '' : 'off'}`}
                                                            onClick={(e) => { e.stopPropagation(); toggleVisibility(layer.id); }}
                                                        >
                                                            {layerVisibility[layer.id] ? '👁' : '—'}
                                                        </button>
                                                        <span className={`badge ${layer.type}`}>
                                                            {layer.type === 'raster' ? 'R' : layer.pmtilesUrl ? 'T' : 'V'}
                                                        </span>
                                                        <span className="name">{loading[layer.id] ? '⏳ ' : ''}{layer.name}</span>
                                                        <div className="layer-actions">
                                                            <button
                                                                className={`icon-btn small swipe-btn ${swipeLayerId === layer.id ? 'active' : ''}`}
                                                                onClick={(e) => { e.stopPropagation(); toggleSwipe(layer.id); }}
                                                                title="Swipe this layer"
                                                            >
                                                                ↔
                                                            </button>
                                                            <button className="icon-btn del" onClick={(e) => { e.stopPropagation(); deleteLayer(layer.id); }}>×</button>
                                                        </div>
                                                    </div>
                                                )}
                                            </Draggable>
                                        ))}
                                        {provided.placeholder}
                                    </div>
                                )}
                            </Droppable>
                        </DragDropContext>
                    )}
                </div>

                {/* Style Editor */}
                <div className="card">
                    <div className="card-title">
                        🎨 Style Editor
                        <button className="toggle-btn" onClick={() => setShowStyleEditor(!showStyleEditor)}>
                            {showStyleEditor ? '▲' : '▼'}
                        </button>
                    </div>
                    {showStyleEditor && (
                        <div className="style-editor">
                            <div className="style-section">
                                <div className="style-section-title">Colors</div>
                                <div className="style-row">
                                    <span>🔴 신축 (New / added)</span>
                                    <input
                                        type="color"
                                        value={styleSettings.newBuild}
                                        onChange={(e) => handleStyleChange('newBuild', e.target.value)}
                                    />
                                </div>
                                <div className="style-row">
                                    <span>🟢 소멸 (Demolished / deleted)</span>
                                    <input
                                        type="color"
                                        value={styleSettings.destroyed}
                                        onChange={(e) => handleStyleChange('destroyed', e.target.value)}
                                    />
                                </div>
                                <div className="style-row">
                                    <span>🔵 갱신 (Updated / changed)</span>
                                    <input
                                        type="color"
                                        value={styleSettings.renewed}
                                        onChange={(e) => handleStyleChange('renewed', e.target.value)}
                                    />
                                </div>
                                <div className="style-row">
                                    <span>⬛ Base Map</span>
                                    <input
                                        type="color"
                                        value={styleSettings.baseMapBorder}
                                        onChange={(e) => handleStyleChange('baseMapBorder', e.target.value)}
                                    />
                                </div>
                            </div>

                            <div className="style-section">
                                <div className="style-section-title">Line Weight</div>
                                <div className="style-row">
                                    <span>Thickness: {styleSettings.lineWeight.toFixed(1)}</span>
                                    <input
                                        type="range"
                                        min="0.5"
                                        max="5"
                                        step="0.5"
                                        value={styleSettings.lineWeight}
                                        onChange={(e) => handleStyleChange('lineWeight', parseFloat(e.target.value))}
                                    />
                                </div>
                            </div>

                            <div className="style-section">
                                <div className="style-section-title">Fill Opacity</div>
                                <div className="style-row">
                                    <span>Opacity: {(styleSettings.fillOpacity * 100).toFixed(0)}%</span>
                                    <input
                                        type="range"
                                        min="0"
                                        max="1"
                                        step="0.05"
                                        value={styleSettings.fillOpacity}
                                        onChange={(e) => handleStyleChange('fillOpacity', parseFloat(e.target.value))}
                                    />
                                </div>
                            </div>

                            <button className="btn" onClick={() => setStyleSettings(DEFAULT_STYLES)}>
                                Reset to Default
                            </button>
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
