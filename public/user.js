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

function phColor(v) {
    if (v === null || v === undefined || v === 0) return '#AAAAAA'
    if (v < 7.0 || v > 9.0) return '#FF4444'
    if (v < 7.5 || v > 8.5) return '#FFD700'
    return '#00E676'
}

// Aquaculture reference range for total alkalinity (mg/L as CaCO3).
function alkColor(v) {
    if (v === null || v === undefined || isNaN(v)) return '#AAAAAA'
    if (v < 30 || v > 200) return '#FF4444'
    if (v < 50 || v > 150) return '#FFD700'
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
let phLineChartInstance = null
let alkLineChartInstance = null
let tempLineChartInstance = null

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
    iconSize: [32, 32],
    iconAnchor: [16, 16]
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

function interpolatedCellColor(lat, lon) {
    if (latestWaterQualityRecords.length === 0) return null
    let wSumPh = 0, wTotalPh = 0, wSumAlk = 0, wTotalAlk = 0
    latestWaterQualityRecords.forEach(r => {
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

    const BLOCK = 5
    for (let y = 0; y < H; y += BLOCK) {
        for (let x = 0; x < W; x += BLOCK) {
            const lon = minLon + (x / W) * lonSpan
            const lat = maxLat - (y / H) * latSpan
            const color = interpolatedCellColor(lat, lon)
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
    const marker = L.circleMarker(e.latlng, { radius: 5, color: '#1a72ff', fillColor: '#1a72ff', fillOpacity: 1 }).addTo(map)
    fieldVertexMarkers.push(marker)
    if (fieldDrawLine) map.removeLayer(fieldDrawLine)
    fieldDrawLine = L.polyline(fieldPoints, { color: '#1a72ff', weight: 2, dashArray: '6,4' }).addTo(map)
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
function clusterByProximity(records, radiusMeters) {
    const clusters = []
    records.forEach(r => {
        const cluster = clusters.find(c => haversineMeters(c.anchorLat, c.anchorLon, r.lat, r.lon) <= radiusMeters)
        if (!cluster) {
            clusters.push({ anchorLat: r.lat, anchorLon: r.lon, latest: r })
        } else if (new Date(r.captured_at) > new Date(cluster.latest.captured_at)) {
            cluster.latest = r
        }
    })
    return clusters
}

function renderMap(records) {
    latestWaterQualityRecords = records
    clearMarkers()
    if (records.length === 0) return

    const clusters = clusterByProximity(records, 1)

    clusters.forEach(cluster => {
        const r = cluster.latest
        const rPh = effPh(r)
        const phTag = (r.ph_am !== null && r.ph_am !== undefined) ? ' (AM)' : (r.ph_pm !== null && r.ph_pm !== undefined) ? ' (PM)' : ''
        const c = L.circleMarker([r.lat, r.lon], {
            radius:      8,
            color:       phColor(rPh),
            fillColor:   phColor(rPh),
            fillOpacity: 0.6
        }).bindPopup(
            `ID ${r.id}<br>pH: ${rPh !== null ? rPh.toFixed(2) : '--'}${phTag}<br>` +
            `Kiềm TGT: ${r.alk_tgt !== null && r.alk_tgt !== undefined ? Number(r.alk_tgt).toFixed(1) : '--'} mg/L<br>` +
            `Kiềm (mg/L): ${r.alk_mgl !== null && r.alk_mgl !== undefined ? Number(r.alk_mgl).toFixed(1) : '--'}<br>` +
            `Ngày đo: ${new Date(r.captured_at).toLocaleString('vi-VN')}`
        )
        c.addTo(map)
        markers.push(c)
    })

    const bounds = L.latLngBounds(records.map(r => [r.lat, r.lon]))
    map.fitBounds(bounds, { padding: [30, 30] })
}

function recordRowHtml(r) {
    const rPh = effPh(r)
    const phTag = (r.ph_am !== null && r.ph_am !== undefined) ? ' (AM)' : (r.ph_pm !== null && r.ph_pm !== undefined) ? ' (PM)' : ''
    return `
        <td>${r.id}</td>
        <td class="cell-lat">${Number(r.lat).toFixed(6)}</td>
        <td class="cell-lon">${Number(r.lon).toFixed(6)}</td>
        <td class="cell-ph"><span class="ph-chip" style="background:${phColor(rPh)}">${rPh !== null ? rPh.toFixed(2) : '--'}${phTag}</span></td>
        <td class="cell-temp">${r.temp !== null ? Number(r.temp).toFixed(1) : '--'}</td>
        <td class="cell-alk">${r.alk_tgt !== null && r.alk_tgt !== undefined ? Number(r.alk_tgt).toFixed(1) : '--'}</td>
        <td class="cell-alk">${r.alk_mgl !== null && r.alk_mgl !== undefined ? Number(r.alk_mgl).toFixed(1) : '--'}</td>
        <td>${new Date(r.captured_at).toLocaleString('vi-VN')}</td>
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

// Groups records into calendar days (00h00–24h00 local time) and shows
// per-day count/avg pH/avg alkalinity, newest day first. Clicking a row
// drills into showDayDetail() for that day.
function renderDailyStats(records) {
    dailyGroups = {}
    records.forEach(r => {
        const day = new Date(r.captured_at).toLocaleDateString('vi-VN')
        if (!dailyGroups[day]) dailyGroups[day] = []
        dailyGroups[day].push(r)
    })

    const days = Object.keys(dailyGroups).sort((a, b) => parseDay(b) - parseDay(a))

    const tbody = document.getElementById('dailyStatsBody')
    tbody.innerHTML = ''
    days.forEach(day => {
        const dayRecords = dailyGroups[day]
        const dayPhVals  = dayRecords.map(effPh).filter(v => v !== null && !isNaN(v))
        const dayAlkVals = dayRecords.map(effAlk).filter(v => v !== null && !isNaN(v))
        const avgPh  = dayPhVals.length  ? dayPhVals.reduce((a, b) => a + b, 0)  / dayPhVals.length  : 0
        const avgAlk = dayAlkVals.length ? dayAlkVals.reduce((a, b) => a + b, 0) / dayAlkVals.length : 0
        const tr = document.createElement('tr')
        tr.className = 'clickable-row-light'
        tr.innerHTML = `
            <td>${day}</td>
            <td>${dayRecords.length}</td>
            <td><span class="ph-chip" style="background:${phColor(avgPh)}">${avgPh.toFixed(2)}</span></td>
            <td>${avgAlk.toFixed(1)}</td>
        `
        tr.addEventListener('click', () => showDayDetail(day))
        tbody.appendChild(tr)
    })
}

function computeAlarmStatus(dayRecords) {
    let dangerCount = 0, warningCount = 0
    dayRecords.forEach(r => {
        const pc = phColor(effPh(r)), ac = alkColor(effAlk(r))
        if (pc === '#FF4444' || ac === '#FF4444') dangerCount++
        else if (pc === '#FFD700' || ac === '#FFD700') warningCount++
    })
    if (dangerCount > 0) return { level: 'danger', text: `NGUY HIỂM — ${dangerCount}/${dayRecords.length} mẫu vượt ngưỡng an toàn` }
    if (warningCount > 0) return { level: 'warning', text: `CẢNH BÁO — ${warningCount}/${dayRecords.length} mẫu ở ngưỡng cần theo dõi` }
    return { level: 'safe', text: `AN TOÀN — toàn bộ ${dayRecords.length} mẫu trong ngưỡng cho phép` }
}

// Draws a semicircle risk gauge: colored zones from `min` to `max`, with a
// needle pointing at `value`. zones: [{ from, to, color }] covering min..max.
function drawGauge(canvasId, value, min, max, zones) {
    const canvas = document.getElementById(canvasId)
    const ctx = canvas.getContext('2d')
    const w = canvas.width, h = canvas.height
    ctx.clearRect(0, 0, w, h)

    const cx = w / 2, cy = h - 14
    const radius = Math.min(w / 2 - 14, h - 28)
    const toAngle = (v) => Math.PI + (Math.max(min, Math.min(max, v)) - min) / (max - min) * Math.PI

    zones.forEach(zone => {
        ctx.beginPath()
        ctx.arc(cx, cy, radius, toAngle(zone.from), toAngle(zone.to))
        ctx.lineWidth = 18
        ctx.strokeStyle = zone.color
        ctx.stroke()
    })

    const angle = toAngle(value)
    const needleLen = radius - 16
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + needleLen * Math.cos(angle), cy + needleLen * Math.sin(angle))
    ctx.lineWidth = 3
    ctx.strokeStyle = '#0a2c4f'
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(cx, cy, 5, 0, Math.PI * 2)
    ctx.fillStyle = '#0a2c4f'
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

const PH_GAUGE_ZONES = [
    { from: 5,   to: 7,   color: '#FF4444' },
    { from: 7,   to: 7.5, color: '#FFD700' },
    { from: 7.5, to: 8.5, color: '#00E676' },
    { from: 8.5, to: 9,   color: '#FFD700' },
    { from: 9,   to: 10,  color: '#FF4444' }
]

const ALK_GAUGE_ZONES = [
    { from: 0,   to: 30,  color: '#FF4444' },
    { from: 30,  to: 50,  color: '#FFD700' },
    { from: 50,  to: 150, color: '#00E676' },
    { from: 150, to: 200, color: '#FFD700' },
    { from: 200, to: 250, color: '#FF4444' }
]

function showDayDetail(day) {
    const dayRecords = dailyGroups[day].slice().sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at))
    document.getElementById('dayDetailTitle').textContent = `Chi tiết ngày ${day}`

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
    document.getElementById('alkGaugeValue').textContent = avgAlk.toFixed(1) + ' mg/L'

    document.getElementById('phStdDev').textContent = '±' + stdDev(phValues).toFixed(3)
    document.getElementById('alkStdDev').textContent = alkValues.length ? '±' + stdDev(alkValues).toFixed(2) + ' mg/L' : '--'
    const n = dayRecords.length
    document.getElementById('sampleConfidence').textContent = n >= 15 ? 'Cao' : n >= 5 ? 'Trung bình' : 'Thấp'

    const labels = dayRecords.map(r => new Date(r.captured_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }))

    if (phLineChartInstance) phLineChartInstance.destroy()
    phLineChartInstance = new Chart(document.getElementById('phLineChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'pH', data: phValuesRaw, borderColor: '#0c6fa8', backgroundColor: 'rgba(12,111,168,0.12)', fill: true, tension: 0.3 }] },
        options: { responsive: true, scales: { y: { min: 5, max: 10 } } }
    })

    if (alkLineChartInstance) alkLineChartInstance.destroy()
    alkLineChartInstance = new Chart(document.getElementById('alkLineChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Kiềm (mg/L)', data: alkValuesRaw, borderColor: '#0a5d8f', backgroundColor: 'rgba(10,93,143,0.12)', fill: true, tension: 0.3 }] },
        options: { responsive: true }
    })

    const tempLineValues = dayRecords.map(r => Number(r.temp))
    if (tempLineChartInstance) tempLineChartInstance.destroy()
    tempLineChartInstance = new Chart(document.getElementById('tempLineChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Nhiệt độ (°C)', data: tempLineValues, borderColor: '#d98c2b', backgroundColor: 'rgba(217,140,43,0.12)', fill: true, tension: 0.3 }] },
        options: { responsive: true }
    })

    setViewMode('day-detail')
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
}

let _lastKnownLatestTs = null

async function loadBoardData() {
    try {
        const res = await fetch(apiUrl('/api/water-quality'), { headers: authHeaders() })
        const records = await res.json()
        records.sort((a, b) => a.id - b.id)
        renderTable(records)
        renderMap(records)
        renderStats(records)
        renderDailyStats(records)
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
async function checkForNewData() {
    if (!_lastKnownLatestTs) return
    try {
        const res = await fetch(apiUrl('/api/water-quality'), { headers: authHeaders() })
        const records = await res.json()
        if (records.length === 0) return
        const latest = records.reduce((a, b) => new Date(a.captured_at) > new Date(b.captured_at) ? a : b)
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

    if (mode === 'map') setTimeout(() => map.invalidateSize(), 50)
    if (mode === 'info') loadProfile()
    if (mode === 'robot') loadRobotData()
    closeDrawer()
}

// MAVLink GPS_FIX_TYPE — see server/sql/schema.sql robot_telemetry.gps_fix comment.
function gpsFixLabel(fix) {
    const labels = { 0: 'No GPS', 1: 'No Fix', 2: '2D', 3: '3D', 4: 'DGPS', 5: 'RTK Float', 6: 'RTK Fixed' }
    return fix === null || fix === undefined || !(fix in labels) ? '--' : labels[fix]
}

let robotDailyGroups = {}
let robotBatteryChartInstance = null
let robotGpsChartInstance = null
let robotSpeedChartInstance = null
let robotThrottleChartInstance = null

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
async function loadRobotData() {
    try {
        const res = await fetch(apiUrl('/api/robot'), { headers: authHeaders() })
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
    document.getElementById('robotDayDetailTitle').textContent = `Robot ngày ${day}`

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
        data: { labels, datasets: [{ label: 'Pin (%)', data: battValues, borderColor: '#2e9e4f', backgroundColor: 'rgba(46,158,79,0.12)', fill: true, tension: 0.3 }] },
        options: { responsive: true, scales: { y: { min: 0, max: 100 } } }
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
                pointRadius:          4,
                fill:                 true,
                tension:              0.3
            }]
        },
        options: { responsive: true, scales: { y: { min: 0 } } }
    })

    const speedValues = dayRecords.map(r => Number(r.speed_mps))

    if (robotSpeedChartInstance) robotSpeedChartInstance.destroy()
    robotSpeedChartInstance = new Chart(document.getElementById('robotSpeedLineChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Vận tốc (m/s)', data: speedValues, borderColor: '#9c27b0', backgroundColor: 'rgba(156,39,176,0.12)', fill: true, tension: 0.3 }] },
        options: { responsive: true, scales: { y: { min: 0 } } }
    })

    const throttleValues = dayRecords.map(r => Number(r.throttle_pct))

    if (robotThrottleChartInstance) robotThrottleChartInstance.destroy()
    robotThrottleChartInstance = new Chart(document.getElementById('robotThrottleLineChart'), {
        type: 'line',
        data: { labels, datasets: [{ label: 'Throttle (%)', data: throttleValues, borderColor: '#e65100', backgroundColor: 'rgba(230,81,0,0.12)', fill: true, tension: 0.3 }] },
        options: { responsive: true, scales: { y: { min: 0, max: 100 } } }
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
        loadRobotData()
    } else {
        loadBoardData()
    }
})

initSession('device', () => {
    loadBoardData()
    setViewMode('map')
})
