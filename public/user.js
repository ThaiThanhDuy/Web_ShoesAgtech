// Mobile chart helpers — only affect narrow screens; desktop keeps defaults.
const _MOBILE       = window.innerWidth < 768
const _CHART_X_TICKS = _MOBILE ? { maxTicksLimit: 6, autoSkip: true } : {}
// Hide data-point dots on mobile (50+ points overlap badly on narrow canvas).
// GPS chart uses _CHART_PT_GPS (1px) to keep per-point fix-type colour visible.
const _CHART_PT     = _MOBILE ? 0 : 3
const _CHART_PT_GPS = _MOBILE ? 1 : 4

// ph_am/ph_pm: only one set per record (split by local hour-of-day at capture)
// — this picks whichever is present. alk_tgt is firmware's real-time alkMgl
// (always present going forward); alk_mgl is only set once today's ΔpH slot
// is FULL (more accurate) — effAlk() falls back to alk_mgl for historical
// rows captured before this split existed (alk_tgt is null on those).
function effPh(r) {
    if (r.ph_am !== null && r.ph_am !== undefined) return Number(r.ph_am)
    if (r.ph_pm !== null && r.ph_pm !== undefined) return Number(r.ph_pm)
    // Historical rows captured before the AM/PM split existed only have `ph`.
    if (r.ph !== null && r.ph !== undefined) return Number(r.ph)
    return null
}
function effAlk(r) {
    // Prefer the ΔpH-validated value when this point has it; fall back to the
    // always-present real-time one so map/chart coverage stays complete.
    if (r.alk_mgl !== null && r.alk_mgl !== undefined) return Number(r.alk_mgl)
    if (r.alk_tgt !== null && r.alk_tgt !== undefined) return Number(r.alk_tgt)
    return null
}

// Thresholds matched to QGC app (FlyViewCustomLayer.qml phColor/alkMglColor).
// pH: danger < 7.0 or > 9.0 | warning < 7.5 or > 8.5
// Kiềm mg/L: danger < 60 or > 200 | warning < 80 or > 160
function phColor(v) {
    if (v === null || v === undefined || isNaN(v) || v === 0) return '#AAAAAA'
    if (v < 7.0 || v > 9.0) return '#FF4444'
    if (v < 7.5 || v > 8.5) return '#FFD700'
    return '#00E676'
}

function phRecordColor(r) {
    if (r.ph_am !== null && r.ph_am !== undefined) return phColor(Number(r.ph_am))
    if (r.ph_pm !== null && r.ph_pm !== undefined) return phColor(Number(r.ph_pm))
    if (r.ph !== null && r.ph !== undefined) return phColor(Number(r.ph))
    return '#AAAAAA'
}

function alkColor(v) {
    if (v === null || v === undefined || isNaN(v)) return '#AAAAAA'
    if (v < 60 || v > 200) return '#FF4444'
    if (v < 80 || v > 160) return '#FFD700'
    return '#00E676'
}

function parseDay(s) {
    const [d, m, y] = s.split('/').map(Number)
    return new Date(y, m - 1, d)
}

function stdDev(values) {
    if (values.length === 0) return 0
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
    return Math.sqrt(variance)
}

let currentViewMode = 'table'
let dailyGroups = {}
let phAmLineChartInstance = null
let phPmLineChartInstance = null
let alkLineChartInstance = null
let tempLineChartInstance = null
let _dayFeedBarChartInst = null
let _dayFeedPieInsts = []

const map = L.map('map').setView([0, 0], 2)

const satelliteLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Esri, Maxar, Earthstar Geographics', maxZoom: 19 }
).addTo(map)

const streetLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors, &copy; CARTO',
    maxZoom: 19
})

L.control.layers({ 'Vệ tinh': satelliteLayer, 'Bản đồ': streetLayer }).addTo(map)

let markers = []
let robotMarker = null

const robotIcon = L.divIcon({
    className: 'robot-marker-wrapper',
    html: '<div class="robot-marker-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="9" width="14" height="11" rx="2"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/><circle cx="9.5" cy="14.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="14.5" cy="14.5" r="1.2" fill="currentColor" stroke="none"/><path d="M9 18h6"/></svg></div>',
    iconSize:  [32, 32],
    iconAnchor:[16, 16]
})

// Shows the robot's last known position (from telemetry, not water-quality
// samples) as a fixed badge on the map — independent of renderMap()'s sample
// markers, so it isn't cleared/redrawn by clearMarkers().
async function loadRobotMarker() {
    try {
        const res = await fetch(apiUrl('/api/robot'), { headers: authHeaders() })
        const records = await res.json()
        if (records.length === 0) return

        const latest = records[0]   // GET /api/robot already returns newest-first
        if (latest.lat === null || latest.lon === null) return

        if (robotMarker) map.removeLayer(robotMarker)
        robotMarker = L.marker([latest.lat, latest.lon], { icon: robotIcon, zIndexOffset: 1000 }).bindPopup(
            `Robot<br>Cập nhật: ${new Date(latest.captured_at).toLocaleString('vi-VN')}<br>` +
            `Pin: ${latest.battery_pct !== null ? Number(latest.battery_pct).toFixed(0) + '%' : '--'}<br>` +
            `Flight mode: ${latest.flight_mode || '--'}`
        )
        robotMarker.addTo(map)
    } catch (err) {
        console.error('Failed to load robot position', err)
    }
}

// ── "Xem theo ngày" — panel on the map page filters renderMap()'s
// water-quality markers to one calendar day. Robot data is intentionally
// left out of this filter — the robot's "latest position" badge above
// always just shows the latest, regardless of which day is picked here. ──

// Days with water-quality samples (dailyGroups), newest first — keeps the
// currently-picked day selected across repopulation (e.g. after a refresh
// adds today as a new option).
function populateMapDaySelect() {
    const sel = document.getElementById('mapDaySelect')
    const sortedDays = Object.keys(dailyGroups).sort((a, b) => parseDay(b) - parseDay(a))
    sel.innerHTML = '<option value="all">Tất cả</option>' +
        sortedDays.map(d => `<option value="${d}">${d}</option>`).join('')
    // Auto-select the newest day (first in sorted list)
    sel.value = sortedDays.length > 0 ? sortedDays[0] : 'all'

    // populate pond select from all records
    const pondSel = document.getElementById('mapPondSelect')
    const ponds = [...new Set(currentTableRecords
        .map(r => (r.pond_idx !== null && r.pond_idx !== undefined) ? Number(r.pond_idx) : null)
        .filter(p => p !== null)
    )].sort((a, b) => a - b)
    pondSel.innerHTML = '<option value="all">Tất cả</option>' +
        ponds.map(p => `<option value="${p}">Ao ${p}</option>`).join('')
    // Auto-select the pond of the most recently captured record
    const latestRec = currentTableRecords.reduce((best, r) =>
        (!best || new Date(r.captured_at) > new Date(best.captured_at)) ? r : best, null)
    const latestPond = latestRec && latestRec.pond_idx !== null && latestRec.pond_idx !== undefined
        ? String(latestRec.pond_idx) : 'all'
    pondSel.value = ponds.map(String).includes(latestPond) ? latestPond : 'all'

    applyMapFilters()
}

function applyMapFilters() {
    const day  = document.getElementById('mapDaySelect').value
    const pond = document.getElementById('mapPondSelect').value
    const ph   = document.getElementById('mapPhSelect').value
    const info = document.getElementById('mapDayInfo')

    let filtered = currentTableRecords
    if (day !== 'all') filtered = filtered.filter(r =>
        new Date(r.captured_at).toLocaleDateString('vi-VN') === day)
    if (pond !== 'all') filtered = filtered.filter(r =>
        (r.pond_idx !== null && r.pond_idx !== undefined) ? Number(r.pond_idx) === Number(pond) : false)
    if (ph === 'am') filtered = filtered.filter(r => r.ph_am !== null && r.ph_am !== undefined)
    if (ph === 'pm') filtered = filtered.filter(r => r.ph_pm !== null && r.ph_pm !== undefined)

    renderMap(filtered, ph)
    info.textContent = filtered.length < currentTableRecords.length ? `${filtered.length} mẫu` : ''
}

document.getElementById('mapDaySelect').addEventListener('change', applyMapFilters)
document.getElementById('mapPondSelect').addEventListener('change', applyMapFilters)
document.getElementById('mapPhSelect').addEventListener('change', applyMapFilters)

// ── "Vẽ ruộng" feature: tap points on the map to outline a field, then
// compute its area and paint a red/yellow/green coverage grid inside it,
// using IDW-interpolated pH/Kiềm from the water-quality samples. ──────────
let latestWaterQualityRecords = []
let mapDrawActive = false
let fieldPoints = []
let fieldVertexMarkers = []
let fieldDrawLine = null
let fieldPolygon = null
let fieldGridLayer = null
let hiddenFieldMarkers = []
let savedFields = []   // [{ polygon, gridLayer, hiddenMarkers }] — committed via mapSaveBtn, survive starting a new drawing

const mapDrawBtnPencilHtml = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>'

function colorSeverity(hex) {
    if (hex === '#FF4444') return 2
    if (hex === '#FFD700') return 1
    if (hex === '#00E676') return 0
    return -1   // gray — no data near this point
}

// Equirectangular projection (good enough at field scale) + shoelace formula.
function computePolygonAreaM2(points) {
    const R = 6371000
    const lat0 = (points.reduce((s, p) => s + p[0], 0) / points.length) * Math.PI / 180
    const xy = points.map(p => [
        R * (p[1] * Math.PI / 180) * Math.cos(lat0),
        R * (p[0] * Math.PI / 180)
    ])
    let area = 0
    for (let i = 0; i < xy.length; i++) {
        const [x1, y1] = xy[i]
        const [x2, y2] = xy[(i + 1) % xy.length]
        area += x1 * y2 - x2 * y1
    }
    return Math.abs(area / 2)
}

function pointInPolygon(lat, lon, points) {
    let inside = false
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [latI, lonI] = points[i]
        const [latJ, lonJ] = points[j]
        if (((lonI > lon) !== (lonJ > lon)) &&
            (lat < (latJ - latI) * (lon - lonI) / (lonJ - lonI) + latI)) {
            inside = !inside
        }
    }
    return inside
}

// Each sample only colors a circle of this radius around itself — outside
// every sample's circle, the cell stays transparent (no blanket-fill wash).
// Overlapping circles blend (weight fades to 0 at the edge), giving soft
// circular coverage blobs instead of either a global-average wash or hard
// nearest-neighbor cells.
const FIELD_COLOR_RADIUS_M = 25

function interpolatedCellColor(lat, lon, records) {
    if (records.length === 0) return null
    let wSumPh = 0, wTotalPh = 0, wSumAlk = 0, wTotalAlk = 0
    records.forEach(r => {
        const d = haversineMeters(lat, lon, r.lat, r.lon)
        if (d > FIELD_COLOR_RADIUS_M) return
        const w = (1 - d / FIELD_COLOR_RADIUS_M) ** 2
        const rPh = effPh(r), rAlk = effAlk(r)
        if (rPh !== null)  { wSumPh  += w * rPh;  wTotalPh  += w }
        if (rAlk !== null) { wSumAlk += w * rAlk; wTotalAlk += w }
    })
    if (wTotalPh === 0 && wTotalAlk === 0) return null

    const interpPh  = wTotalPh  > 0 ? wSumPh  / wTotalPh  : null
    const interpAlk = wTotalAlk > 0 ? wSumAlk / wTotalAlk : null

    const phHex  = phColor(interpPh)
    const alkHex = alkColor(interpAlk)
    const phSeverity  = colorSeverity(phHex)
    const alkSeverity = colorSeverity(alkHex)

    if (phSeverity === -1 && alkSeverity === -1) return null
    return phSeverity >= alkSeverity ? phHex : alkHex
}

// Renders a smooth, blurred red/yellow/green coverage map (DJI-style crop
// health overlay) instead of a blocky grid: paint the IDW color field onto an
// off-screen canvas, blur it for soft blending between zones, then clip a
// second canvas to the exact polygon outline (no jagged steps at the edge)
// and show that as a single image overlay positioned over the bounding box.
function drawFieldGradient(points) {
    if (fieldGridLayer) { map.removeLayer(fieldGridLayer); fieldGridLayer = null }

    const lats = points.map(p => p[0])
    const lons = points.map(p => p[1])
    const minLat = Math.min(...lats), maxLat = Math.max(...lats)
    const minLon = Math.min(...lons), maxLon = Math.max(...lons)
    const latSpan = maxLat - minLat
    const lonSpan = maxLon - minLon
    if (latSpan === 0 || lonSpan === 0) return

    const RES = 240
    const midLatRad = ((minLat + maxLat) / 2) * Math.PI / 180
    const aspect = (lonSpan * Math.cos(midLatRad)) / latSpan
    const W = aspect >= 1 ? RES : Math.max(60, Math.round(RES * aspect))
    const H = aspect >= 1 ? Math.max(60, Math.round(RES / aspect)) : RES

    const srcCanvas = document.createElement('canvas')
    srcCanvas.width = W
    srcCanvas.height = H
    const srcCtx = srcCanvas.getContext('2d')

    // Prefilter to records reachable from within this bbox — eliminates records
    // that can't influence any pixel, avoiding haversine calls per-pixel for them.
    const radLat = FIELD_COLOR_RADIUS_M / 111000
    const radLon = FIELD_COLOR_RADIUS_M / (111000 * Math.cos(midLatRad))
    const nearbyRecords = latestWaterQualityRecords.filter(r =>
        r.lat >= minLat - radLat && r.lat <= maxLat + radLat &&
        r.lon >= minLon - radLon && r.lon <= maxLon + radLon
    )

    const BLOCK = 5
    for (let y = 0; y < H; y += BLOCK) {
        for (let x = 0; x < W; x += BLOCK) {
            const lon = minLon + (x / W) * lonSpan
            const lat = maxLat - (y / H) * latSpan
            const color = interpolatedCellColor(lat, lon, nearbyRecords)
            if (!color) continue
            srcCtx.fillStyle = color
            srcCtx.fillRect(x, y, BLOCK, BLOCK)
        }
    }

    const outCanvas = document.createElement('canvas')
    outCanvas.width = W
    outCanvas.height = H
    const outCtx = outCanvas.getContext('2d')

    outCtx.save()
    outCtx.beginPath()
    points.forEach((p, i) => {
        const x = ((p[1] - minLon) / lonSpan) * W
        const y = (1 - (p[0] - minLat) / latSpan) * H
        if (i === 0) outCtx.moveTo(x, y); else outCtx.lineTo(x, y)
    })
    outCtx.closePath()
    outCtx.clip()
    outCtx.filter = 'blur(6px)'
    outCtx.drawImage(srcCanvas, 0, 0)
    outCtx.restore()

    fieldGridLayer = L.imageOverlay(outCanvas.toDataURL(), [[minLat, minLon], [maxLat, maxLon]], {
        opacity: 0.5,
        interactive: false
    }).addTo(map)
    if (fieldPolygon) fieldPolygon.bringToFront()
}

function onMapDrawClick(e) {
    fieldPoints.push([e.latlng.lat, e.latlng.lng])
    const marker = L.circleMarker(e.latlng, { radius: 5, color: '#00C853', fillColor: '#00C853', fillOpacity: 1 }).addTo(map)
    fieldVertexMarkers.push(marker)
    if (fieldDrawLine) map.removeLayer(fieldDrawLine)
    fieldDrawLine = L.polyline(fieldPoints, { color: '#00C853', weight: 2, dashArray: '6,4' }).addTo(map)
}

function clearFieldOverlay() {
    fieldPoints = []
    fieldVertexMarkers.forEach(m => map.removeLayer(m))
    fieldVertexMarkers = []
    if (fieldDrawLine)  { map.removeLayer(fieldDrawLine);  fieldDrawLine  = null }
    if (fieldPolygon)   { map.removeLayer(fieldPolygon);   fieldPolygon   = null }
    if (fieldGridLayer) { map.removeLayer(fieldGridLayer); fieldGridLayer = null }
    hiddenFieldMarkers.forEach(m => m.addTo(map))
    hiddenFieldMarkers = []
}

function finishFieldDrawing() {
    if (fieldPoints.length < 3) {
        alert('Cần ít nhất 3 điểm để tạo diện tích ruộng')
        clearFieldOverlay()
        return
    }

    fieldVertexMarkers.forEach(m => map.removeLayer(m))
    fieldVertexMarkers = []
    if (fieldDrawLine) { map.removeLayer(fieldDrawLine); fieldDrawLine = null }

    const areaM2 = computePolygonAreaM2(fieldPoints)
    fieldPolygon = L.polygon(fieldPoints, { color: '#00C853', weight: 2, fillOpacity: 0 }).addTo(map)

    const insideRecords = latestWaterQualityRecords.filter(r => pointInPolygon(r.lat, r.lon, fieldPoints))
    const phValues  = insideRecords.map(effPh).filter(v => v !== null && !isNaN(v))
    const alkValues = insideRecords.map(effAlk).filter(v => v !== null && !isNaN(v))
    const avgPh  = phValues.length  ? phValues.reduce((a, b) => a + b, 0) / phValues.length   : null
    const avgAlk = alkValues.length ? alkValues.reduce((a, b) => a + b, 0) / alkValues.length : null

    const fieldBounds = L.latLngBounds(fieldPoints)
    const topCenter = [fieldBounds.getNorth(), (fieldBounds.getWest() + fieldBounds.getEast()) / 2]
    fieldPolygon.bindTooltip(
        `Diện tích: ${areaM2.toFixed(1)} m²<br>` +
        `pH TB: ${avgPh !== null ? avgPh.toFixed(2) : '--'} · Kiềm TB: ${avgAlk !== null ? avgAlk.toFixed(1) + ' mg/L' : '--'}`,
        { permanent: true, direction: 'top', offset: [0, -8], className: 'field-area-tooltip' }
    )
    fieldPolygon.openTooltip(topCenter)

    drawFieldGradient(fieldPoints)

    // Sample dots inside the drawn field clutter the coverage overlay — hide
    // just those (markers outside the field stay visible as normal). Restored
    // by clearFieldOverlay() if this drawing never gets saved (new drawing or
    // "Xóa hết"); stay hidden permanently once committed via mapSaveBtn.
    hiddenFieldMarkers = markers.filter(m => pointInPolygon(m.getLatLng().lat, m.getLatLng().lng, fieldPoints))
    hiddenFieldMarkers.forEach(m => map.removeLayer(m))
}

// Commits the current (unsaved) drawing so starting a new one won't wipe it —
// detaches it from the fieldPolygon/fieldGridLayer/hiddenFieldMarkers "current
// draft" tracking into savedFields, where only "Xóa hết" can remove it.
function saveCurrentField() {
    if (!fieldPolygon) return
    savedFields.push({ polygon: fieldPolygon, gridLayer: fieldGridLayer, hiddenMarkers: hiddenFieldMarkers })
    fieldPolygon = null
    fieldGridLayer = null
    fieldPoints = []
    hiddenFieldMarkers = []
}

function clearAllFieldOverlays() {
    clearFieldOverlay()
    savedFields.forEach(f => {
        map.removeLayer(f.polygon)
        if (f.gridLayer) map.removeLayer(f.gridLayer)
        f.hiddenMarkers.forEach(m => m.addTo(map))
    })
    savedFields = []
}

function toggleMapDraw() {
    const btn = document.getElementById('mapDrawBtn')
    if (!mapDrawActive) {
        clearFieldOverlay()
        mapDrawActive = true
        btn.classList.add('map-draw-btn-active')
        btn.innerHTML = 'Xong'
        map.on('click', onMapDrawClick)
    } else {
        mapDrawActive = false
        map.off('click', onMapDrawClick)
        btn.classList.remove('map-draw-btn-active')
        btn.innerHTML = mapDrawBtnPencilHtml
        finishFieldDrawing()
    }
}

function clearMarkers() {
    markers.forEach(m => map.removeLayer(m))
    markers = []
}

function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000
    const toRad = d => d * Math.PI / 180
    const dLat = toRad(lat2 - lat1)
    const dLon = toRad(lon2 - lon1)
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Repeated samples taken at "the same spot" (GPS error ~1m) would otherwise
// stack overlapping circles on the map. Group them by proximity to the first
// point seen in each group (a fixed anchor avoids the group's center drifting
// as more nearby points get added) and keep only the most recently captured
// record per group for display — the table still lists every individual row.
// O(N) grid-bucket clustering — each record lands in one grid cell, then only
// the 3×3 neighbourhood of cells is searched for an existing cluster anchor.
// Worst case is still O(N×9) but 9 is a fixed constant, not proportional to N.
function clusterByProximity(records, radiusMeters) {
    const cellDeg  = radiusMeters / 111000
    const grid     = {}   // grid-cell key → index in clusters[]
    const clusters = []

    records.forEach(r => {
        const ci = Math.floor(r.lat / cellDeg)
        const cj = Math.floor(r.lon / cellDeg)
        let foundIdx = -1
        outer: for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
                const key = `${ci + di},${cj + dj}`
                if (key in grid) {
                    const idx = grid[key]
                    if (haversineMeters(clusters[idx].anchorLat, clusters[idx].anchorLon, r.lat, r.lon) <= radiusMeters) {
                        foundIdx = idx
                        break outer
                    }
                }
            }
        }
        if (foundIdx === -1) {
            grid[`${ci},${cj}`] = clusters.length
            clusters.push({ anchorLat: r.lat, anchorLon: r.lon, latest: r })
        } else if (new Date(r.captured_at) > new Date(clusters[foundIdx].latest.captured_at)) {
            clusters[foundIdx].latest = r
        }
    })
    return clusters
}

function renderMap(records, phMode) {
    latestWaterQualityRecords = records
    clearMarkers()
    if (records.length === 0) return

    const clusters = clusterByProximity(records, 1)

    clusters.forEach(cluster => {
        const r = cluster.latest
        // pick pH value and color based on active filter
        let rPh, markerColor, phTag
        if (phMode === 'am') {
            rPh = (r.ph_am !== null && r.ph_am !== undefined) ? Number(r.ph_am) : null
            markerColor = phColor(rPh)
            phTag = ' (Sáng)'
        } else if (phMode === 'pm') {
            rPh = (r.ph_pm !== null && r.ph_pm !== undefined) ? Number(r.ph_pm) : null
            markerColor = phColor(rPh)
            phTag = ' (Chiều)'
        } else {
            rPh = effPh(r)
            markerColor = phRecordColor(r)
            phTag = (r.ph_am !== null && r.ph_am !== undefined) ? ' (Sáng)' : (r.ph_pm !== null && r.ph_pm !== undefined) ? ' (Chiều)' : ''
        }
        const c = L.circleMarker([r.lat, r.lon], {
            radius:      8,
            color:       markerColor,
            fillColor:   markerColor,
            fillOpacity: 0.6
        }).bindPopup(
            `ID ${r.id}<br>pH: ${rPh !== null ? rPh.toFixed(2) : '--'}${phTag}<br>` +
            `Kiềm: ${r.alk_dkh !== null && r.alk_dkh !== undefined ? Number(r.alk_dkh).toFixed(2) + ' dKH' : '--'} | ${r.alk_mgl !== null && r.alk_mgl !== undefined ? Number(r.alk_mgl).toFixed(1) + ' mg/L' : '--'}<br>` +
            `AO: ${r.pond_idx !== null && r.pond_idx !== undefined ? r.pond_idx : '--'}<br>` +
            `Ngày đo: ${new Date(r.captured_at).toLocaleString('vi-VN')}`
        )
        c.addTo(map)
        markers.push(c)
    })

    const bounds = L.latLngBounds(records.map(r => [r.lat, r.lon]))
    map.fitBounds(bounds, { padding: [30, 30] })
}

function recordRowHtml(r) {
    return `
        <td>${r.id}</td>
        <td class="cell-lat">${Number(r.lat).toFixed(6)}</td>
        <td class="cell-lon">${Number(r.lon).toFixed(6)}</td>
        <td class="cell-ph"><span class="ph-chip" style="background:${phColor(r.ph_am !== null && r.ph_am !== undefined ? Number(r.ph_am) : null)}">${r.ph_am !== null && r.ph_am !== undefined ? Number(r.ph_am).toFixed(2) : '--'}</span></td>
        <td class="cell-ph"><span class="ph-chip" style="background:${phColor(r.ph_pm !== null && r.ph_pm !== undefined ? Number(r.ph_pm) : null)}">${r.ph_pm !== null && r.ph_pm !== undefined ? Number(r.ph_pm).toFixed(2) : '--'}</span></td>
        <td class="cell-ph">${r.delta_ph !== null && r.delta_ph !== undefined ? Number(r.delta_ph).toFixed(2) : '--'}</td>
        <td class="cell-temp">${r.temp !== null ? Number(r.temp).toFixed(1) : '--'}</td>
        <td class="cell-alk">${r.alk_dkh !== null && r.alk_dkh !== undefined ? Number(r.alk_dkh).toFixed(2) : '--'}</td>
        <td class="cell-alk">${r.alk_mgl !== null && r.alk_mgl !== undefined ? Number(r.alk_mgl).toFixed(1) : '--'}</td>
        <td>${r.pond_idx !== null && r.pond_idx !== undefined ? r.pond_idx : '--'}</td>
        <td>${new Date(r.captured_at).toLocaleString('vi-VN')}</td>
        <td><button class="small-btn danger-btn delete-btn" data-id="${r.id}">Xóa</button></td>
    `
}

function renderStats(records) {
    const bar = document.getElementById('statsBar')
    if (records.length === 0) {
        bar.classList.add('hidden')
        return
    }
    bar.classList.remove('hidden')

    const latest = records.reduce((a, b) => new Date(a.captured_at) > new Date(b.captured_at) ? a : b)
    document.getElementById('statLatest').textContent = new Date(latest.captured_at).toLocaleString('vi-VN')
}

// Groups records by (day × pond) and shows one row per combo, newest day first,
// pond ascending. Clicking a row drills into showDayDetail() for that day.
function renderDailyStats(records) {
    dailyGroups = {}
    const pondGroups = {}   // key: "day||pond"

    records.forEach(r => {
        const day  = new Date(r.captured_at).toLocaleDateString('vi-VN')
        const pond = (r.pond_idx !== null && r.pond_idx !== undefined) ? Number(r.pond_idx) : 0
        if (!dailyGroups[day]) dailyGroups[day] = []
        dailyGroups[day].push(r)
        const key = `${day}||${pond}`
        if (!pondGroups[key]) pondGroups[key] = { day, pond, records: [] }
        pondGroups[key].records.push(r)
    })

    const rows = Object.values(pondGroups).sort((a, b) => {
        const dc = parseDay(b.day) - parseDay(a.day)
        return dc !== 0 ? dc : a.pond - b.pond
    })

    const tbody = document.getElementById('dailyStatsBody')
    tbody.innerHTML = ''
    rows.forEach(({ day, pond, records: recs }) => {
        const phVals  = recs.map(effPh).filter(v => v !== null && !isNaN(v))
        const alkVals = recs.map(effAlk).filter(v => v !== null && !isNaN(v))
        const avgPh  = phVals.length  ? phVals.reduce((a, b)  => a + b, 0) / phVals.length  : 0
        const avgAlk = alkVals.length ? alkVals.reduce((a, b) => a + b, 0) / alkVals.length : 0
        const lastTs = recs.reduce((max, r) => {
            const t = r.captured_at ? new Date(r.captured_at) : null
            return (t && (!max || t > max)) ? t : max
        }, null)
        const lastTime = lastTs ? lastTs.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : ''
        const tr = document.createElement('tr')
        tr.className = 'clickable-row-light'
        tr.innerHTML = `
            <td>${day}<br><span class="stat-last-time">${lastTime}</span></td>
            <td>Ao ${pond}</td>
            <td>${recs.length}</td>
            <td><span class="ph-chip" style="background:${phColor(avgPh)}">${avgPh.toFixed(2)}</span></td>
            <td>${avgAlk.toFixed(1)}</td>
        `
        tr.addEventListener('click', () => showDayDetail(day, pond))
        tbody.appendChild(tr)
    })

}

function computeAlarmStatus(dayRecords) {
    let dangerCount = 0, warningCount = 0
    dayRecords.forEach(r => {
        const pc = phRecordColor(r), ac = alkColor(effAlk(r))
        if (pc === '#FF4444' || ac === '#FF4444') dangerCount++
        else if (pc === '#FFD700' || ac === '#FFD700') warningCount++
    })
    // Banner's background still follows the worst case (danger wins), but the
    // text mentions BOTH counts when they co-occur instead of hiding the
    // warning-level samples just because some others already hit danger.
    const total = dayRecords.length
    if (dangerCount > 0) {
        let text = `Nguy hiểm - ${dangerCount}/${total} mẫu ở ngưỡng nguy hiểm`
        if (warningCount > 0) text += `, ${warningCount}/${total} mẫu ở ngưỡng cảnh báo`
        return { level: 'danger', text }
    }
    if (warningCount > 0) return { level: 'warning', text: `Cần kiểm tra - ${warningCount}/${total} mẫu ở ngưỡng cảnh báo` }
    return { level: 'safe', text: `An toàn - toàn bộ ${total} mẫu trong ngưỡng cho phép` }
}

// Draws a semicircle risk gauge: colored zones from `min` to `max`, with a
// needle pointing at `value`. zones: [{ from, to, color }] covering min..max.
// Zone boundary values (min..max, de-duplicated) — just the printed numbers
// around the band, no tick lines, like a SCADA dial's scale.
function _gaugeTicks(zones) {
    const vals = new Set()
    zones.forEach(zone => { vals.add(zone.from); vals.add(zone.to) })
    return Array.from(vals).sort((a, b) => a - b)
}

function _fmtGaugeTick(v) {
    return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

// Conic gradient instead of one hard-edged color per zone — blends smoothly
// through each boundary instead of cutting straight from e.g. red to yellow.
// createConicGradient's offsets run 0..1 over a FULL turn starting at
// `startAngle`; our dial only ever covers half a turn (toAngle's range is
// min..max → Math.PI..2*Math.PI), so min..max maps to offsets 0..0.5 here.
function _gaugeGradient(ctx, cx, cy, min, max, zones) {
    const gradient = ctx.createConicGradient(Math.PI, cx, cy)
    const toOffset = (v) => (Math.max(min, Math.min(max, v)) - min) / (max - min) * 0.5
    gradient.addColorStop(0, zones[0].color)
    zones.forEach(zone => {
        gradient.addColorStop(toOffset((zone.from + zone.to) / 2), zone.color)
    })
    gradient.addColorStop(0.5, zones[zones.length - 1].color)
    return gradient
}

function drawGauge(canvasId, value, min, max, zones) {
    const canvas = document.getElementById(canvasId)
    const ctx = canvas.getContext('2d')
    const w = canvas.width, h = canvas.height
    ctx.clearRect(0, 0, w, h)

    const cx = w / 2, cy = h - 16
    // Radius leaves a margin around the band for the number labels.
    const radius = Math.min(w / 2 - 32, h - 42)
    const toAngle = (v) => Math.PI + (Math.max(min, Math.min(max, v)) - min) / (max - min) * Math.PI

    ctx.beginPath()
    ctx.arc(cx, cy, radius, toAngle(min), toAngle(max))
    ctx.lineWidth = 18
    ctx.strokeStyle = _gaugeGradient(ctx, cx, cy, min, max, zones)
    ctx.stroke()

    // Canvas drawing can't see CSS vars — pick ink color by theme directly so
    // labels/needle stay readable on the dark surface (was always #0a2c4f).
    const inkColor = document.documentElement.getAttribute('data-theme') === 'dark' ? '#ffffff' : '#0a2c4f'

    ctx.font = 'bold 13px sans-serif'
    ctx.fillStyle = inkColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    _gaugeTicks(zones).forEach(tick => {
        const a = toAngle(tick)
        const labelR = radius + 22
        ctx.fillText(_fmtGaugeTick(tick), cx + labelR * Math.cos(a), cy + labelR * Math.sin(a))
    })

    // Needle — short & thick (SCADA dial style), tip almost touching the
    // band's inner edge instead of leaving a big gap.
    const angle = toAngle(value)
    const needleLen = radius
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + needleLen * Math.cos(angle), cy + needleLen * Math.sin(angle))
    ctx.lineWidth = 7
    ctx.lineCap = 'round'
    ctx.strokeStyle = inkColor
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(cx, cy, 7, 0, Math.PI * 2)
    ctx.fillStyle = inkColor
    ctx.fill()
}

const gaugeAnimHandles = {}

function easeInOutQuad(t) {
    return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2
}

// Self-test sweep, like a car dashboard: needle runs min→max→min, then eases
// up to the real value, instead of just snapping straight to it.
function animateGaugeNeedle(canvasId, finalValue, min, max, zones) {
    if (gaugeAnimHandles[canvasId]) cancelAnimationFrame(gaugeAnimHandles[canvasId])

    const toMax  = 700
    const toMin  = 700
    const toReal = 850
    const total  = toMax + toMin + toReal
    const start  = performance.now()

    function frame(now) {
        const elapsed = now - start
        let value
        if (elapsed < toMax) {
            value = min + (max - min) * easeInOutQuad(elapsed / toMax)
        } else if (elapsed < toMax + toMin) {
            value = max - (max - min) * easeInOutQuad((elapsed - toMax) / toMin)
        } else if (elapsed < total) {
            value = min + (finalValue - min) * easeInOutQuad((elapsed - toMax - toMin) / toReal)
        } else {
            value = finalValue
        }

        drawGauge(canvasId, value, min, max, zones)

        if (elapsed < total) {
            gaugeAnimHandles[canvasId] = requestAnimationFrame(frame)
        } else {
            gaugeAnimHandles[canvasId] = null
        }
    }
    gaugeAnimHandles[canvasId] = requestAnimationFrame(frame)
}

// avgPh/avgAlk below blend sáng+chiều samples together (whole-day average),
// so these use phColor()'s envelope range.
const PH_GAUGE_ZONES = [
    { from: 5,   to: 7,   color: '#FF4444' },
    { from: 7,   to: 7.5, color: '#FFD700' },
    { from: 7.5, to: 8.5, color: '#00E676' },
    { from: 8.5, to: 9.0, color: '#FFD700' },
    { from: 9.0, to: 10,  color: '#FF4444' }
]

const ALK_GAUGE_ZONES = [
    { from: 0,   to: 60,  color: '#FF4444' },
    { from: 60,  to: 80,  color: '#FFD700' },
    { from: 80,  to: 160, color: '#00E676' },
    { from: 160, to: 200, color: '#FFD700' },
    { from: 200, to: 250, color: '#FF4444' }
]

function _renderAlkMonthlyChart(monthKey) {
    const [year, month] = monthKey.split('-').map(Number)
    const days = Object.keys(dailyGroups)
        .filter(d => { const p = parseDay(d); return p.getFullYear() === year && p.getMonth() + 1 === month })
        .sort((a, b) => parseDay(a) - parseDay(b))

    const labels = days
    const tgtValues = days.map(day => {
        const recs = dailyGroups[day].filter(r => r.alk_tgt !== null && r.alk_tgt !== undefined)
        if (recs.length === 0) return null
        return recs.reduce((s, r) => s + Number(r.alk_tgt), 0) / recs.length
    })
    const mglValues = days.map(day => {
        const recs = dailyGroups[day].filter(r => r.alk_mgl !== null && r.alk_mgl !== undefined)
        if (recs.length === 0) return null
        return recs.reduce((s, r) => s + Number(r.alk_mgl), 0) / recs.length
    })

    if (alkLineChartInstance) alkLineChartInstance.destroy()
    alkLineChartInstance = new Chart(document.getElementById('alkLineChart'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Kiềm (mg/L)', data: tgtValues, borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.10)', fill: false, tension: 0.3, spanGaps: true, pointRadius: 4 },
                { label: 'ΔpH (mg/L)', data: mglValues, borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.12)',  fill: true,  tension: 0.3, spanGaps: true, pointRadius: 4 }
            ]
        },
        options: {
            responsive: true,
            scales: {
                y: { min: 0, title: { display: true, text: 'mg/L' } },
                x: { ticks: { ..._CHART_X_TICKS, maxRotation: 45 } }
            }
        }
    })

    // Độ lệch chuẩn kiềm theo tháng — dùng daily-avg alk_tgt (luôn có) của tháng này
    const monthAlkValues = tgtValues.filter(v => v !== null && !isNaN(v))
    const alkStdEl = document.getElementById('alkStdDev')
    if (alkStdEl) alkStdEl.textContent = monthAlkValues.length > 1 ? '±' + stdDev(monthAlkValues).toFixed(2) + ' mg/L' : '--'
}

function _populateAlkMonthSelect(selectMonthKey) {
    const months = {}
    Object.keys(dailyGroups).forEach(day => {
        const d = parseDay(day)
        const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
        months[key] = `Tháng ${d.getMonth()+1}/${d.getFullYear()}`
    })
    const sel = document.getElementById('alkMonthSelect')
    const sorted = Object.keys(months).sort((a, b) => b.localeCompare(a))
    sel.innerHTML = sorted.map(k => `<option value="${k}"${k === selectMonthKey ? ' selected' : ''}>${months[k]}</option>`).join('')
    _renderAlkMonthlyChart(sel.value)
}

document.getElementById('alkMonthSelect').addEventListener('change', () => {
    _renderAlkMonthlyChart(document.getElementById('alkMonthSelect').value)
})

let _currentDayDetail = { day: null, pond: null }

function showDayDetail(day, pond) {
    _currentDayDetail = { day, pond }
    const allDay = dailyGroups[day] || []
    const dayRecords = (pond !== undefined && pond !== null
        ? allDay.filter(r => {
            const rp = (r.pond_idx !== null && r.pond_idx !== undefined) ? Number(r.pond_idx) : 0
            return rp === Number(pond)
          })
        : allDay
    ).slice().sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))

    document.getElementById('dayDetailTitle').textContent =
        pond !== undefined && pond !== null ? `Chi tiết ngày ${day} — Ao ${pond}` : `Chi tiết ngày ${day}`

    // Raw (one entry per record, null = gap) for charts — must stay aligned
    // with `labels` below; filtered versions (for avg/stdDev) come after.
    const phValuesRaw = dayRecords.map(effPh)
    const alkValuesRaw = dayRecords.map(effAlk)
    const phValues = phValuesRaw.filter(v => v !== null && !isNaN(v))
    const alkValues = alkValuesRaw.filter(v => v !== null && !isNaN(v))

    const avgPh = phValues.length ? phValues.reduce((a, b) => a + b, 0) / phValues.length : 0
    const avgAlk = alkValues.length ? alkValues.reduce((a, b) => a + b, 0) / alkValues.length : 0

    const status = computeAlarmStatus(dayRecords)
    const banner = document.getElementById('alarmBanner')
    banner.className = `alarm-banner ${status.level}`
    banner.textContent = status.text

    animateGaugeNeedle('phGaugeCanvas', avgPh, 5, 10, PH_GAUGE_ZONES)
    document.getElementById('phGaugeValue').textContent = avgPh.toFixed(2)

    animateGaugeNeedle('alkGaugeCanvas', avgAlk, 0, 250, ALK_GAUGE_ZONES)
    document.getElementById('alkGaugeValue').innerHTML = `${avgAlk.toFixed(1)}<span class="gauge-unit">mg/L</span>`

    document.getElementById('phStdDev').textContent = '±' + stdDev(phValues).toFixed(3)
    // alkStdDev is updated by _renderAlkMonthlyChart (monthly scope)
    const n = dayRecords.length
    document.getElementById('sampleConfidence').textContent = n >= 15 ? 'Cao' : n >= 5 ? 'Trung bình' : 'Thấp'

    const labels = dayRecords.map(r => new Date(r.captured_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }))

    // pH split into 2 mini charts (sáng/chiều) — separate from effPh's merged
    // value above, which stays as-is for the gauge/stdDev aggregate stats.
    const phAmValuesRaw = dayRecords.map(r => (r.ph_am !== null && r.ph_am !== undefined) ? Number(r.ph_am) : null)
    const phPmValuesRaw = dayRecords.map(r => (r.ph_pm !== null && r.ph_pm !== undefined) ? Number(r.ph_pm) : null)

    if (phAmLineChartInstance) phAmLineChartInstance.destroy()
    phAmLineChartInstance = new Chart(document.getElementById('phAmLineChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'pH Sáng', data: phAmValuesRaw, borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.12)', fill: true, tension: 0.3 }] },
        options: { responsive: true, scales: { y: { min: 5, max: 10 }, x: { ticks: { ..._CHART_X_TICKS } } } }
    })

    if (phPmLineChartInstance) phPmLineChartInstance.destroy()
    phPmLineChartInstance = new Chart(document.getElementById('phPmLineChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'pH Chiều', data: phPmValuesRaw, borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.12)', fill: true, tension: 0.3 }] },
        options: { responsive: true, scales: { y: { min: 5, max: 10 }, x: { ticks: { ..._CHART_X_TICKS } } } }
    })

    // Alk chart is now monthly — sync its month selector to the day being viewed
    const viewedDate = parseDay(day)
    const viewedMonthKey = `${viewedDate.getFullYear()}-${String(viewedDate.getMonth()+1).padStart(2,'0')}`
    _populateAlkMonthSelect(viewedMonthKey)

    const tempLineValues = dayRecords.map(r => Number(r.temp))
    if (tempLineChartInstance) tempLineChartInstance.destroy()
    tempLineChartInstance = new Chart(document.getElementById('tempLineChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Nhiệt độ (°C)', data: tempLineValues, borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,0.12)', fill: true, tension: 0.3 }] },
        options: { responsive: true, scales: { x: { ticks: { ..._CHART_X_TICKS } } } }
    })

    _renderDayFeedingCharts(day, pond)
    setViewMode('day-detail')
}

// Bản ghi cũ trước khi có cột func đều là khảo sát "Cho ăn" — coi null/thiếu là feed.
// Biểu đồ lượng ăn/nhá cữ trong ngày chỉ có ý nghĩa với dữ liệu Cho ăn (đơn vị kg);
// trộn lẫn dữ liệu Phun chất lỏng (lít)/Rải chất rắn vào sẽ làm sai tổng.
function isFeedRec(r) { return !r.func || r.func === 'Cho ăn' }

function _renderDayFeedingCharts(day, pond) {
    const QUESTIONS = [
        {
            key: 'feedback', title: 'Nhá cữ',
            labels: ['Hết', 'Còn ít', 'Còn nhiều', 'Không kiểm tra'],
            colors: ['#4caf50', '#ffb300', '#ef5350', '#90a4ae']
        },
        {
            key: 'route', title: 'Đường chạy',
            labels: ['Đường chạy cũ', 'Đường chạy mới'],
            colors: ['#5c6bc0', '#26c6da']
        }
    ]

    const dayRecs = _feedingRecords.filter(r => {
        if (!isFeedRec(r)) return false
        if (!r.captured_at) return false
        if (new Date(r.captured_at).toLocaleDateString('vi-VN') !== day) return false
        if (pond !== undefined && pond !== null) {
            const rp = (r.pond_idx !== null && r.pond_idx !== undefined) ? Number(r.pond_idx) : 0
            if (rp !== Number(pond)) return false
        }
        return true
    })

    const section = document.getElementById('dayFeedingSection')
    if (dayRecs.length === 0) { section.classList.add('hidden'); return }
    section.classList.remove('hidden')

    const byPond = {}
    dayRecs.forEach(r => {
        const pond = (r.pond_idx !== null && r.pond_idx !== undefined) ? Number(r.pond_idx) : 0
        if (!byPond[pond]) {
            byPond[pond] = { totalKg: 0, feedback: {}, route: {} }
        }
        byPond[pond].totalKg += (r.food_kg !== null && r.food_kg !== undefined) ? Number(r.food_kg) : 0
        QUESTIONS.forEach(q => {
            const val = r[q.key] || '--'
            byPond[pond][q.key][val] = (byPond[pond][q.key][val] || 0) + 1
        })
    })
    const ponds = Object.keys(byPond).map(Number).sort((a, b) => a - b)

    // line chart — food amount over time (individual records, sorted by time)
    const feedSorted = dayRecs.slice().sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))
    const feedLabels = feedSorted.map(r => new Date(r.captured_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }))
    const feedValsLine = feedSorted.map(r => (r.food_kg !== null && r.food_kg !== undefined) ? Number(r.food_kg) : null)

    if (_dayFeedBarChartInst) _dayFeedBarChartInst.destroy()
    _dayFeedBarChartInst = new Chart(document.getElementById('dayFeedBarChart'), {
        type: 'line',
        data: {
            labels: feedLabels,
            datasets: [{
                label: 'Lượng ăn (kg)',
                data: feedValsLine,
                borderColor: '#16a34a',
                backgroundColor: 'rgba(22,163,74,0.10)',
                fill: true,
                tension: 0.3,
                pointRadius: 5,
                pointBackgroundColor: '#16a34a',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: true, labels: { color: '#4d6478', font: { size: 12 } } },
                tooltip: { callbacks: { label: ctx => `${ctx.parsed.y.toFixed(2)} kg` } }
            },
            scales: {
                y: { min: 0, title: { display: true, text: 'kg' }, grid: { color: 'rgba(0,0,0,0.05)' } },
                x: { grid: { color: 'rgba(0,0,0,0.05)' } }
            }
        }
    })

    // pie charts — 4 questions × N ponds
    _dayFeedPieInsts.forEach(c => c.destroy())
    _dayFeedPieInsts = []
    const wrap = document.getElementById('dayFeedPieWrap')
    wrap.innerHTML = ''

    ponds.forEach(pond => {
        const pondSection = document.createElement('div')
        pondSection.className = 'feed-pond-section'
        pondSection.innerHTML = `<div class="feed-pond-title">Ao ${pond} — ${byPond[pond].totalKg.toFixed(1)} kg</div><div class="feed-pie-row" id="feedPieRow_${pond}"></div>`
        wrap.appendChild(pondSection)

        const row = document.getElementById(`feedPieRow_${pond}`)
        QUESTIONS.forEach((q, qi) => {
            const counts = q.labels.map(lb => byPond[pond][q.key][lb] || 0)
            const total  = counts.reduce((a, b) => a + b, 0)
            if (total === 0) return
            const pctLabels = q.labels.map((lb, i) =>
                total > 0 ? `${lb} (${Math.round(counts[i] / total * 100)}%)` : lb)
            const card = document.createElement('div')
            card.className = 'feed-pie-card chart-card'
            card.innerHTML = `<div class="feed-pie-label">${q.title}</div><canvas id="feedPie_${pond}_${qi}"></canvas>`
            row.appendChild(card)
            const inst = new Chart(document.getElementById(`feedPie_${pond}_${qi}`), {
                type: 'pie',
                data: {
                    labels: pctLabels,
                    datasets: [{ data: counts, backgroundColor: q.colors, borderWidth: 1 }]
                },
                options: {
                    responsive: true,
                    plugins: {
                        legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12 } },
                        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed} lần` } }
                    }
                }
            })
            _dayFeedPieInsts.push(inst)
        })
    })
}

function renderTable(records) {
    const tbody = document.getElementById('recordsBody')
    tbody.innerHTML = ''
    records.forEach(r => {
        const tr = document.createElement('tr')
        tr.dataset.id = r.id
        tr.innerHTML = recordRowHtml(r)
        tbody.appendChild(tr)
    })
    tbody.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteTableRecord(btn.dataset.id))
    })
}

// DELETE /api/water-quality/:id is admin-only (server-side). A real board
// account viewing its own data here can't delete — point them at the admin.
// But when an admin opens this same page via "Chi tiết" (?asDevice=..., see
// shared.js's viewingAsDeviceUid), authHeaders() still carries the ADMIN's own
// credentials, so the request passes requireAdminAuth — let it through.
async function deleteTableRecord(id) {
    if (!viewingAsDeviceUid) {
        alert('Vui lòng liên hệ admin để xóa.')
        return
    }
    if (!confirm('Xóa record này?')) return
    try {
        const res = await fetch(`/api/water-quality/${id}`, { method: 'DELETE', headers: authHeaders() })
        if (!res.ok) { alert('Xóa thất bại'); return }
        loadBoardData()
    } catch (err) {
        alert('Lỗi kết nối server')
    }
}

// Sortable "Bảng dữ liệu" table — currentTableRecords holds the canonical
// (unsorted-by-user) dataset from the last loadBoardData(); sorting re-renders
// from that copy so it survives without refetching, and re-applies itself
// after a refresh (loadBoardData calls applyCurrentTableSort() instead of
// renderTable() directly once a sort is active).
let currentTableRecords = []
let tableSortKey = null
let tableSortDir = 1   // 1 = ascending, -1 = descending

function _tableSortValue(r, key) {
    if (key === 'captured_at') return new Date(r.captured_at).getTime()
    const v = r[key]
    return (v === null || v === undefined) ? null : Number(v)
}

function applyCurrentTableSort() {
    if (!tableSortKey) { renderTable(currentTableRecords); return }
    const sorted = currentTableRecords.slice().sort((a, b) => {
        const va = _tableSortValue(a, tableSortKey)
        const vb = _tableSortValue(b, tableSortKey)
        if (va === null && vb === null) return 0
        if (va === null) return 1    // nulls always last, regardless of direction
        if (vb === null) return -1
        return (va - vb) * tableSortDir
    })
    renderTable(sorted)
    document.querySelectorAll('#recordsHeadRow .sort-arrow').forEach(el => {
        const dir = el.dataset.dir === 'asc' ? 1 : -1
        el.classList.toggle('active', el.closest('th').dataset.sortKey === tableSortKey && dir === tableSortDir)
    })
}

// Builds the ▲▼ buttons once per header cell instead of repeating near-identical
// markup for all 10 columns in user.html.
document.querySelectorAll('#recordsHeadRow th[data-sort-key]').forEach(th => {
    const key = th.dataset.sortKey
    const wrap = document.createElement('span')
    wrap.className = 'sort-arrows'
    wrap.innerHTML = '<span class="sort-arrow" data-dir="asc">▲</span><span class="sort-arrow" data-dir="desc">▼</span>'
    th.appendChild(wrap)
    wrap.querySelectorAll('.sort-arrow').forEach(el => {
        el.addEventListener('click', () => {
            tableSortKey = key
            tableSortDir = el.dataset.dir === 'asc' ? 1 : -1
            applyCurrentTableSort()
        })
    })
})

let _lastKnownLatestTs = null

async function loadBoardData() {
    try {
        const [wqRes, feedRes] = await Promise.all([
            fetch(apiUrl('/api/water-quality'), { headers: authHeaders() }),
            fetch(apiUrl('/api/feeding'),       { headers: authHeaders() })
        ])
        const records = await wqRes.json()
        records.sort((a, b) => a.id - b.id)
        currentTableRecords = records
        if (feedRes.ok) _feedingRecords = await feedRes.json()
        applyCurrentTableSort()
        renderMap(records)
        renderStats(records)
        renderDailyStats(records)
        // dailyGroups (built by renderDailyStats above) is what "Xem theo
        // ngày" reads from — refresh it here so the dropdown has today's
        // data even when this resolves after setViewMode('map') already ran.
        populateMapDaySelect()
        loadRobotMarker()
        if (records.length > 0) {
            _lastKnownLatestTs = records.reduce((a, b) => new Date(a.captured_at) > new Date(b.captured_at) ? a : b).captured_at
        }
        setNewDataAvailable(false)
    } catch (err) {
        console.error('Failed to load records', err)
    }
}

// Polls for newer records than what's currently loaded — raises the yellow
// header dot instead of auto-refreshing, so the user decides when to reload.
// Uses /latest (single row) instead of fetching all 2000 records.
async function checkForNewData() {
    if (!_lastKnownLatestTs) return
    try {
        const res    = await fetch(apiUrl('/api/water-quality/latest'), { headers: authHeaders() })
        const latest = await res.json()
        if (!latest) return
        if (new Date(latest.captured_at) > new Date(_lastKnownLatestTs)) {
            setNewDataAvailable(true)
        }
    } catch (err) {
        // connection-status polling already surfaces offline state
    }
}

setInterval(checkForNewData, 20000)

// Shows exactly one of the 6 panes (table/map/stats/robot/day-detail/info) and
// updates the drawer's active item ('day-detail' is a drill-down from
// 'stats', not a drawer item itself, so nothing gets highlighted for it).
function setViewMode(mode) {
    currentViewMode = mode
    document.querySelectorAll('.drawer-item').forEach(el => el.classList.toggle('active', el.dataset.view === mode))

    document.getElementById('tablePane').classList.toggle('hidden', mode !== 'table')
    document.getElementById('mapPane').classList.toggle('hidden', mode !== 'map')
    document.getElementById('statsPane').classList.toggle('hidden', mode !== 'stats')
    document.getElementById('robotPane').classList.toggle('hidden', mode !== 'robot')
    document.getElementById('robotDayDetailPane').classList.toggle('hidden', mode !== 'robot-day-detail')
    document.getElementById('dayDetailPane').classList.toggle('hidden', mode !== 'day-detail')
    document.getElementById('feedingPane').classList.toggle('hidden', mode !== 'feeding')
    document.getElementById('infoPane').classList.toggle('hidden', mode !== 'info')

    document.getElementById('mapSaveBtn').classList.toggle('hidden', mode !== 'map')
    document.getElementById('mapDrawBtn').classList.toggle('hidden', mode !== 'map')
    document.getElementById('mapClearBtn').classList.toggle('hidden', mode !== 'map')
    if (mode !== 'map' && mapDrawActive) {
        mapDrawActive = false
        map.off('click', onMapDrawClick)
        const btn = document.getElementById('mapDrawBtn')
        btn.classList.remove('map-draw-btn-active')
        btn.innerHTML = mapDrawBtnPencilHtml
    }

    if (mode === 'map') {
        setTimeout(() => map.invalidateSize(), 50)
        populateMapDaySelect()
    }
    if (mode === 'info') loadProfile()
    if (mode === 'robot') loadRobotData()
    if (mode === 'feeding') loadFeedingData()
    closeDrawer()
}

// MAVLink GPS_FIX_TYPE — see server/sql/schema.sql robot_telemetry.gps_fix comment.
function gpsFixLabel(fix) {
    const labels = { 0: 'No GPS', 1: 'No Fix', 2: '2D', 3: '3D', 4: 'DGPS', 5: 'RTK Float', 6: 'RTK Fixed' }
    return fix === null || fix === undefined || !(fix in labels) ? '--' : labels[fix]
}

let robotDailyGroups   = {}
let _robotDataLoaded   = false
let robotBatteryChartInstance  = null
let robotGpsChartInstance      = null
let robotSpeedChartInstance    = null
let robotThrottleChartInstance = null
let robotMissionDistChart      = null
let robotActualDistChart       = null

// Same red/yellow/green logic as MAVLink GPS_FIX_TYPE: <2 = no usable fix,
// 2 = 2D (weak), >=3 = 3D or better (strong).
function gpsFixColor(fix) {
    if (fix === null || fix === undefined || fix < 2) return '#FF4444'
    if (fix === 2) return '#FFD700'
    return '#00E676'
}

// Groups robot telemetry into calendar days (00h00–24h00 local time): "Giờ mở
// máy"/"Giờ tắt máy" are the first/last telemetry timestamps seen that day
// (there's no explicit power-on/off event over MAVLink — the data simply
// stops arriving once the board is off), the rest are day averages/latest.
// Clicking a row drills into showRobotDayDetail() for that day.
async function loadRobotData(force = false) {
    if (_robotDataLoaded && !force) return
    try {
        const res = await fetch(apiUrl('/api/robot?days=30'), { headers: authHeaders() })
        const records = await res.json()

        robotDailyGroups = {}
        records.forEach(r => {
            const day = new Date(r.captured_at).toLocaleDateString('vi-VN')
            if (!robotDailyGroups[day]) robotDailyGroups[day] = []
            robotDailyGroups[day].push(r)
        })

        const days = Object.keys(robotDailyGroups).sort((a, b) => parseDay(b) - parseDay(a))

        const tbody = document.getElementById('robotDailyBody')
        tbody.innerHTML = ''
        days.forEach(day => {
            const dayRecords = robotDailyGroups[day].slice().sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))
            const first = dayRecords[0]
            const last = dayRecords[dayRecords.length - 1]

            const battValues = dayRecords.map(r => Number(r.battery_pct)).filter(v => !isNaN(v))
            const avgBatt = battValues.length ? battValues.reduce((a, b) => a + b, 0) / battValues.length : null
            const satValues = dayRecords.map(r => Number(r.gps_sats)).filter(v => !isNaN(v))
            const avgSats = satValues.length ? satValues.reduce((a, b) => a + b, 0) / satValues.length : null
            const speedValues = dayRecords.map(r => Number(r.speed_mps)).filter(v => !isNaN(v))
            const avgSpeed = speedValues.length ? speedValues.reduce((a, b) => a + b, 0) / speedValues.length : null
            const throttleValues = dayRecords.map(r => Number(r.throttle_pct)).filter(v => !isNaN(v))
            const avgThrottle = throttleValues.length ? throttleValues.reduce((a, b) => a + b, 0) / throttleValues.length : null

            const fmtTime = (ts) => new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })

            const tr = document.createElement('tr')
            tr.className = 'clickable-row-light'
            tr.innerHTML = `
                <td>${day}</td>
                <td>${first.device_id || '--'}</td>
                <td>${fmtTime(first.captured_at)}</td>
                <td>${fmtTime(last.captured_at)}</td>
                <td>${avgBatt !== null ? avgBatt.toFixed(0) : '--'}</td>
                <td>${gpsFixLabel(last.gps_fix)}${avgSats !== null ? ' · ' + avgSats.toFixed(0) + ' vệ tinh' : ''}</td>
                <td>${last.flight_mode || '--'}</td>
                <td>${avgSpeed !== null ? avgSpeed.toFixed(2) : '--'}</td>
                <td>${avgThrottle !== null ? avgThrottle.toFixed(0) : '--'}</td>
                <td>${last.lat !== null && last.lon !== null ? Number(last.lat).toFixed(6) + ', ' + Number(last.lon).toFixed(6) : '--'}</td>
            `
            tr.addEventListener('click', () => showRobotDayDetail(day))
            tbody.appendChild(tr)
        })
        _robotDataLoaded = true
    } catch (err) {
        console.error('Failed to load robot telemetry', err)
    }
}

function formatDuration(ms) {
    const totalMinutes = Math.round(ms / 60000)
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return `${hours}h ${minutes}m`
}

function showRobotDayDetail(day) {
    const dayRecords = robotDailyGroups[day].slice().sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))
    const robotId = dayRecords[0]?.device_id || ''
    document.getElementById('robotDayDetailTitle').textContent = robotId ? `${robotId} — ${day}` : `Robot ngày ${day}`

    const first = dayRecords[0]
    const last = dayRecords[dayRecords.length - 1]
    const usageMs = new Date(last.captured_at) - new Date(first.captured_at)
    document.getElementById('robotUsageDuration').textContent = formatDuration(usageMs)

    const firstBatt = Number(first.battery_pct)
    const lastBatt = Number(last.battery_pct)
    document.getElementById('robotBatteryRange').textContent =
        (!isNaN(firstBatt) ? firstBatt.toFixed(0) : '--') + '% → ' + (!isNaN(lastBatt) ? lastBatt.toFixed(0) : '--') + '%'

    const labels = dayRecords.map(r => new Date(r.captured_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }))
    const battValues = dayRecords.map(r => Number(r.battery_pct))

    if (robotBatteryChartInstance) robotBatteryChartInstance.destroy()
    robotBatteryChartInstance = new Chart(document.getElementById('robotBatteryLineChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Pin (%)', data: battValues, borderColor: '#2e9e4f', backgroundColor: 'rgba(46,158,79,0.12)', fill: true, tension: 0.3, pointRadius: _CHART_PT }] },
        options: { responsive: true, scales: { y: { min: 0, max: 100 }, x: { ticks: { ..._CHART_X_TICKS } } } }
    })

    const satValues = dayRecords.map(r => Number(r.gps_sats))
    const pointColors = dayRecords.map(r => gpsFixColor(r.gps_fix))

    if (robotGpsChartInstance) robotGpsChartInstance.destroy()
    robotGpsChartInstance = new Chart(document.getElementById('robotGpsLineChart'), {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label:                'Số vệ tinh',
                data:                 satValues,
                borderColor:          '#0c6fa8',
                backgroundColor:      'rgba(12,111,168,0.12)',
                pointBackgroundColor: pointColors,
                pointBorderColor:     pointColors,
                pointRadius:          _CHART_PT_GPS,
                fill:                 true,
                tension:              0.3
            }]
        },
        options: { responsive: true, scales: { y: { min: 0 }, x: { ticks: { ..._CHART_X_TICKS } } } }
    })

    const speedValues = dayRecords.map(r => Number(r.speed_mps))

    if (robotSpeedChartInstance) robotSpeedChartInstance.destroy()
    robotSpeedChartInstance = new Chart(document.getElementById('robotSpeedLineChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Vận tốc (m/s)', data: speedValues, borderColor: '#9c27b0', backgroundColor: 'rgba(156,39,176,0.12)', fill: true, tension: 0.3, pointRadius: _CHART_PT }] },
        options: { responsive: true, scales: { y: { min: 0 }, x: { ticks: { ..._CHART_X_TICKS } } } }
    })

    const throttleValues = dayRecords.map(r => Number(r.throttle_pct))

    if (robotThrottleChartInstance) robotThrottleChartInstance.destroy()
    robotThrottleChartInstance = new Chart(document.getElementById('robotThrottleLineChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Throttle (%)', data: throttleValues, borderColor: '#e65100', backgroundColor: 'rgba(230,81,0,0.12)', fill: true, tension: 0.3, pointRadius: _CHART_PT }] },
        options: { responsive: true, scales: { y: { min: 0, max: 100 }, x: { ticks: { ..._CHART_X_TICKS } } } }
    })

    const missionDistValues = dayRecords.map(r => r.mission_dist_m !== null && r.mission_dist_m !== undefined ? Number(r.mission_dist_m) : null)
    const actualDistValues  = dayRecords.map(r => r.actual_dist_m  !== null && r.actual_dist_m  !== undefined ? Number(r.actual_dist_m)  : null)

    if (robotMissionDistChart) robotMissionDistChart.destroy()
    robotMissionDistChart = new Chart(document.getElementById('robotMissionDistChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Mission (m)', data: missionDistValues, borderColor: '#0288d1', backgroundColor: 'rgba(2,136,209,0.12)', fill: true, tension: 0.3, spanGaps: true, pointRadius: _CHART_PT }] },
        options: { responsive: true, plugins: { tooltip: { callbacks: { label: ctx => ctx.parsed.y !== null ? `${ctx.parsed.y.toFixed(0)} m` : '--' } } }, scales: { y: { min: 0, title: { display: true, text: 'm' } }, x: { ticks: { ..._CHART_X_TICKS } } } }
    })

    if (robotActualDistChart) robotActualDistChart.destroy()
    robotActualDistChart = new Chart(document.getElementById('robotActualDistChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Thực tế (m)', data: actualDistValues, borderColor: '#f57c00', backgroundColor: 'rgba(245,124,0,0.12)', fill: true, tension: 0.3, spanGaps: true, pointRadius: _CHART_PT }] },
        options: { responsive: true, plugins: { tooltip: { callbacks: { label: ctx => ctx.parsed.y !== null ? `${ctx.parsed.y.toFixed(0)} m` : '--' } } }, scales: { y: { min: 0, title: { display: true, text: 'm' } }, x: { ticks: { ..._CHART_X_TICKS } } } }
    })

    setViewMode('robot-day-detail')
}

async function loadProfile() {
    document.getElementById('profileDeviceUid').value = viewingAsDeviceUid || session.deviceUid || ''
    try {
        const res = await fetch(apiUrl('/api/profile'), { headers: authHeaders() })
        const profile = await res.json()
        document.getElementById('profileHo').value = (profile && profile.ho) || ''
        document.getElementById('profileTen').value = (profile && profile.ten) || ''
        document.getElementById('profilePhone').value = (profile && profile.phone) || ''
        document.getElementById('profileAddress').value = (profile && profile.address) || ''
        document.getElementById('profileSupplier').value = (profile && profile.supplier) || ''
    } catch (err) {
        console.error('Failed to load profile', err)
    }
}

document.getElementById('profileSaveBtn').addEventListener('click', async () => {
    const body = {
        ho: document.getElementById('profileHo').value.trim(),
        ten: document.getElementById('profileTen').value.trim(),
        phone: document.getElementById('profilePhone').value.trim(),
        address: document.getElementById('profileAddress').value.trim(),
        supplier: document.getElementById('profileSupplier').value.trim()
    }
    if (viewingAsDeviceUid) body.deviceUid = viewingAsDeviceUid
    const msg = document.getElementById('profileMsg')
    try {
        const res = await fetch('/api/profile', { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) })
        if (!res.ok) {
            const errBody = await res.json().catch(() => ({}))
            msg.textContent = errBody.error || 'Lưu thất bại'
            msg.className = 'error'
            return
        }
        msg.textContent = 'Đã lưu'
        msg.className = 'ok'
    } catch (err) {
        msg.textContent = 'Lỗi kết nối server'
        msg.className = 'error'
    }
})

document.getElementById('profileDeleteBtn').addEventListener('click', async () => {
    if (!confirm('Xóa toàn bộ thông tin này?')) return
    try {
        const res = await fetch(apiUrl('/api/profile'), { method: 'DELETE', headers: authHeaders() })
        if (!res.ok) { alert('Xóa thất bại'); return }
        loadProfile()
    } catch (err) {
        alert('Lỗi kết nối server')
    }
})

document.querySelectorAll('.drawer-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault()
        setViewMode(item.dataset.view)
    })
})

document.getElementById('backToStatsBtn').addEventListener('click', () => setViewMode('stats'))
document.getElementById('backToRobotBtn').addEventListener('click', () => setViewMode('robot'))

document.getElementById('mapSaveBtn').addEventListener('click', saveCurrentField)
document.getElementById('mapDrawBtn').addEventListener('click', toggleMapDraw)
document.getElementById('mapClearBtn').addEventListener('click', () => {
    if (mapDrawActive) {
        mapDrawActive = false
        map.off('click', onMapDrawClick)
        const btn = document.getElementById('mapDrawBtn')
        btn.classList.remove('map-draw-btn-active')
        btn.innerHTML = mapDrawBtnPencilHtml
    }
    clearAllFieldOverlays()
})

document.getElementById('refreshBtn').addEventListener('click', () => {
    if (currentViewMode === 'robot') {
        loadRobotData(true)
    } else if (currentViewMode === 'feeding') {
        loadFeedingData(true)
    } else {
        loadBoardData()
    }
})

// ── So sánh ao (modal) ────────────────────────────────────────────────────
let _pondPhChartInst   = null
let _pondAlkChartInst  = null
let _pondFeedChartInst = null

function _renderPondCompare() {
    const byPond = {}
    Object.values(dailyGroups).forEach(recs => {
        recs.forEach(r => {
            const pond = (r.pond_idx !== null && r.pond_idx !== undefined) ? Number(r.pond_idx) : 0
            if (!byPond[pond]) byPond[pond] = { pond, phVals: [], alkVals: [], foodKg: 0 }
            const ph  = effPh(r)
            const alk = effAlk(r)
            if (ph  !== null && !isNaN(ph))  byPond[pond].phVals.push(ph)
            if (alk !== null && !isNaN(alk)) byPond[pond].alkVals.push(alk)
        })
    })
    // merge feeding totals per pond (chỉ tính dữ liệu "Cho ăn" — cùng đơn vị kg)
    _feedingRecords.filter(isFeedRec).forEach(r => {
        const pond = (r.pond_idx !== null && r.pond_idx !== undefined) ? Number(r.pond_idx) : 0
        if (!byPond[pond]) byPond[pond] = { pond, phVals: [], alkVals: [], foodKg: 0 }
        byPond[pond].foodKg += (r.food_kg !== null && r.food_kg !== undefined) ? Number(r.food_kg) : 0
    })

    const ponds = Object.values(byPond).sort((a, b) => a.pond - b.pond)
    const body  = document.getElementById('pondCompareBody')
    if (ponds.length === 0) {
        body.innerHTML = '<p style="color:var(--ink-soft);text-align:center;padding:20px">Chưa có dữ liệu</p>'
        return
    }

    const avg     = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
    const labels  = ponds.map(p => `Ao ${p.pond}`)
    const phVals  = ponds.map(p => avg(p.phVals))
    const alkVals = ponds.map(p => avg(p.alkVals))
    const feedVals = ponds.map(p => parseFloat(p.foodKg.toFixed(2)))
    const phColors  = phVals.map(v => phColor(v))
    const alkColors = alkVals.map(v => alkColor(v))

    const defined = arr => arr.filter(v => v !== null && !isNaN(v))
    const phDef  = defined(phVals)
    const alkDef = defined(alkVals)
    const phDiff  = phDef.length  >= 2 ? Math.max(...phDef)  - Math.min(...phDef)  : null
    const alkDiff = alkDef.length >= 2 ? Math.max(...alkDef) - Math.min(...alkDef) : null
    const phMin = phDef.length ? Math.min(...phDef) : 5
    const phMax = phDef.length ? Math.max(...phDef) : 10

    body.innerHTML = `
        <div class="compare-section-title">pH trung bình theo ao</div>
        <canvas id="pondPhChart" height="160"></canvas>
        ${phDiff !== null ? `<p class="compare-delta">Độ chênh lệch pH: <strong>${phDiff.toFixed(3)}</strong></p>` : ''}
        <div class="compare-section-title" style="margin-top:20px">Kiềm trung bình theo ao (mg/L)</div>
        <canvas id="pondAlkChart" height="160"></canvas>
        ${alkDiff !== null ? `<p class="compare-delta">Độ chênh lệch kiềm: <strong>${alkDiff.toFixed(2)} mg/L</strong></p>` : ''}
        <div class="compare-section-title" style="margin-top:20px">Lượng thức ăn theo ao (kg)</div>
        <canvas id="pondFeedChart" height="160"></canvas>
    `

    if (_pondPhChartInst)   _pondPhChartInst.destroy()
    if (_pondAlkChartInst)  _pondAlkChartInst.destroy()
    if (_pondFeedChartInst) _pondFeedChartInst.destroy()

    _pondPhChartInst = new Chart(document.getElementById('pondPhChart'), {
        type: 'bar',
        data: { labels, datasets: [{ label: 'pH TB', data: phVals.map(v => v !== null ? parseFloat(v.toFixed(3)) : null), backgroundColor: phColors, borderColor: phColors, borderWidth: 1, borderRadius: 5 }] },
        options: { responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `pH: ${ctx.parsed.y.toFixed(2)}` } } }, scales: { y: { min: Math.max(0, phMin - 0.3), max: phMax + 0.3, title: { display: true, text: 'pH' } } } }
    })

    _pondAlkChartInst = new Chart(document.getElementById('pondAlkChart'), {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Kiềm TB (mg/L)', data: alkVals.map(v => v !== null ? parseFloat(v.toFixed(2)) : null), backgroundColor: alkColors, borderColor: alkColors, borderWidth: 1, borderRadius: 5 }] },
        options: { responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `Kiềm: ${ctx.parsed.y.toFixed(1)} mg/L` } } }, scales: { y: { min: 0, title: { display: true, text: 'mg/L' } } } }
    })

    _pondFeedChartInst = new Chart(document.getElementById('pondFeedChart'), {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Tổng lượng ăn (kg)', data: feedVals, backgroundColor: 'rgba(76,175,80,0.7)', borderColor: 'rgba(76,175,80,1)', borderWidth: 1, borderRadius: 5 }] },
        options: { responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.parsed.y.toFixed(2)} kg` } } }, scales: { y: { min: 0, title: { display: true, text: 'kg' } } } }
    })
}

document.getElementById('comparePondsBtn').addEventListener('click', () => {
    _renderPondCompare()
    document.getElementById('pondCompareOverlay').classList.remove('hidden')
})

document.getElementById('pondCompareCloseBtn').addEventListener('click', () => {
    document.getElementById('pondCompareOverlay').classList.add('hidden')
})

document.getElementById('pondCompareOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('pondCompareOverlay'))
        document.getElementById('pondCompareOverlay').classList.add('hidden')
})

// ── Dữ liệu cho ăn ────────────────────────────────────────────────────────
let _feedingRecords = []
let _feedingSortKey = 'captured_at'
let _feedingSortDir = -1  // -1 = desc

function _feedingSortBy(key) {
    if (_feedingSortKey === key) {
        _feedingSortDir *= -1
    } else {
        _feedingSortKey = key
        _feedingSortDir = -1
    }
    _renderFeedingTable()
}

function _renderFeedingTable() {
    const sorted = _feedingRecords.slice().sort((a, b) => {
        const av = a[_feedingSortKey]
        const bv = b[_feedingSortKey]
        if (av === null || av === undefined) return 1
        if (bv === null || bv === undefined) return -1
        if (typeof av === 'string') return _feedingSortDir * av.localeCompare(bv, 'vi')
        return _feedingSortDir * (av - bv)
    })

    const tbody = document.getElementById('feedingBody')
    if (!tbody) return
    tbody.innerHTML = ''

    sorted.forEach(r => {
        const ts     = r.captured_at ? new Date(r.captured_at).toLocaleString('vi-VN') : '--'
        const amount = r.food_kg !== null && r.food_kg !== undefined
            ? `${Number(r.food_kg).toFixed(1)} ${r.unit || 'kg'}` : '--'
        const tr = document.createElement('tr')
        tr.innerHTML = `
            <td>${r.id}</td>
            <td>${r.func ?? 'Cho ăn'}</td>
            <td>Ao ${r.pond_idx ?? '--'}</td>
            <td>${r.buoi ?? '--'}</td>
            <td>${r.feedback ?? '--'}</td>
            <td>${r.category ?? '--'}</td>
            <td>${amount}</td>
            <td>${r.decision ?? '--'}</td>
            <td>${r.route ?? '--'}</td>
            <td>${ts}</td>
            <td><button class="small-btn danger-btn" data-feed-id="${r.id}">Xóa</button></td>
        `
        tbody.appendChild(tr)
    })

    tbody.querySelectorAll('[data-feed-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Xóa bản ghi này?')) return
            const id = btn.dataset.feedId
            try {
                const res = await fetch(apiUrl(`/api/feeding/${id}`), { method: 'DELETE', headers: authHeaders() })
                if (!res.ok) { alert('Xóa thất bại'); return }
                _feedingRecords = _feedingRecords.filter(x => x.id !== Number(id))
                _renderFeedingTable()
            } catch (err) {
                alert('Lỗi kết nối server')
            }
        })
    })
}

let _feedingDataLoaded = false

async function loadFeedingData(force = false) {
    if (_feedingDataLoaded && !force) return
    try {
        const res = await fetch(apiUrl('/api/feeding'), { headers: authHeaders() })
        if (!res.ok) return
        _feedingRecords = await res.json()
        _renderFeedingTable()
        _feedingDataLoaded = true
    } catch (err) {
        console.error('Failed to load feeding data', err)
    }
}

// Sort on header click — delegate from the pane so it's always bound
document.getElementById('feedingPane').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort-key]')
    if (th) _feedingSortBy(th.dataset.sortKey)
})

// ── Excel export (.xlsx via SheetJS) ─────────────────────────────────────────
function _downloadXlsx(filename, headers, rows) {
    const data = [headers, ...rows.map(r => r.map(v => v === null || v === undefined ? '' : v))]
    const ws = XLSX.utils.aoa_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    XLSX.writeFile(wb, filename)
}

function exportWqDay() {
    const { day, pond } = _currentDayDetail
    if (!day) return
    const allDay = dailyGroups[day] || []
    const recs = (pond !== undefined && pond !== null
        ? allDay.filter(r => {
            const rp = (r.pond_idx !== null && r.pond_idx !== undefined) ? Number(r.pond_idx) : 0
            return rp === Number(pond)
          })
        : allDay
    ).slice().sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))

    const headers = ['STT', 'Thời gian', 'Ao', 'pH Sáng', 'pH Chiều', 'ΔpH', 'Kiềm (dKH)', 'Kiềm (mg/L)', 'Nhiệt độ (°C)', 'Lat', 'Lon']
    const rows = recs.map((r, i) => [
        i + 1,
        r.captured_at ? new Date(r.captured_at).toLocaleString('vi-VN') : '',
        r.pond_idx ?? '',
        r.ph_am !== null && r.ph_am !== undefined ? Number(r.ph_am).toFixed(2) : '',
        r.ph_pm !== null && r.ph_pm !== undefined ? Number(r.ph_pm).toFixed(2) : '',
        r.delta_ph !== null && r.delta_ph !== undefined ? Number(r.delta_ph).toFixed(2) : '',
        r.alk_dkh !== null && r.alk_dkh !== undefined ? Number(r.alk_dkh).toFixed(2) : '',
        r.alk_mgl !== null && r.alk_mgl !== undefined ? Number(r.alk_mgl).toFixed(1) : '',
        r.temp !== null && r.temp !== undefined ? Number(r.temp).toFixed(1) : '',
        r.lat !== null && r.lat !== undefined ? Number(r.lat).toFixed(6) : '',
        r.lon !== null && r.lon !== undefined ? Number(r.lon).toFixed(6) : ''
    ])
    const safePond = pond !== undefined && pond !== null ? `_ao${pond}` : ''
    _downloadXlsx(`Water_monitoring_${day.replace(/\//g, '-')}${safePond}.xlsx`, headers, rows)
}

function exportFeedDay() {
    const { day, pond } = _currentDayDetail
    if (!day) return
    const recs = _feedingRecords.filter(r => {
        if (!r.captured_at) return false
        if (new Date(r.captured_at).toLocaleDateString('vi-VN') !== day) return false
        if (pond !== undefined && pond !== null) {
            const rp = (r.pond_idx !== null && r.pond_idx !== undefined) ? Number(r.pond_idx) : 0
            if (rp !== Number(pond)) return false
        }
        return true
    }).slice().sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))

    const headers = ['STT', 'Thời gian', 'Robot', 'Chức năng', 'Ao', 'Buổi', 'Nhá cữ', 'Loại', 'Lượng dùng', 'Đơn vị', 'Quyết định', 'Đường chạy']
    const rows = recs.map((r, i) => [
        i + 1,
        r.captured_at ? new Date(r.captured_at).toLocaleString('vi-VN') : '',
        r.device_id ?? '',
        r.func ?? 'Cho ăn',
        r.pond_idx ?? '',
        r.buoi ?? '',
        r.feedback ?? '',
        r.category ?? '',
        r.food_kg !== null && r.food_kg !== undefined ? Number(r.food_kg).toFixed(2) : '',
        r.unit ?? 'kg',
        r.decision ?? '',
        r.route ?? ''
    ])
    const safePond = pond !== undefined && pond !== null ? `_ao${pond}` : ''
    _downloadXlsx(`Feeding_${day.replace(/\//g, '-')}${safePond}.xlsx`, headers, rows)
}

document.getElementById('exportWqBtn').addEventListener('click', exportWqDay)
document.getElementById('exportFeedBtn').addEventListener('click', exportFeedDay)

initSession('device', () => {
    loadBoardData()
    setViewMode('map')
})
