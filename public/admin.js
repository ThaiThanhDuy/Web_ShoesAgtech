function phColor(v) {
    if (v === null || v === undefined || v === 0) return '#AAAAAA'
    if (v < 7.0 || v > 9.0) return '#FF4444'
    if (v < 7.5 || v > 8.5) return '#FFD700'
    return '#00E676'
}

let currentBoardUid = null   // which board's data is currently shown
let currentViewMode = 'users'

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
    clearMarkers()
    if (records.length === 0) return

    const clusters = clusterByProximity(records, 1)

    clusters.forEach(cluster => {
        const r = cluster.latest
        const c = L.circleMarker([r.lat, r.lon], {
            radius:      8,
            color:       phColor(r.ph),
            fillColor:   phColor(r.ph),
            fillOpacity: 0.6
        }).bindPopup(
            `ID ${r.id}<br>pH: ${Number(r.ph).toFixed(2)}<br>Kiềm: ${r.alk_mgl !== null ? Number(r.alk_mgl).toFixed(1) : '--'} mg/L<br>Ngày đo: ${new Date(r.captured_at).toLocaleString('vi-VN')}`
        )
        c.addTo(map)
        markers.push(c)
    })

    const bounds = L.latLngBounds(records.map(r => [r.lat, r.lon]))
    map.fitBounds(bounds, { padding: [30, 30] })
}

const robotIcon = L.divIcon({
    className: 'robot-marker-wrapper',
    html: '<div class="robot-marker-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="9" width="14" height="11" rx="2"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/><circle cx="9.5" cy="14.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="14.5" cy="14.5" r="1.2" fill="currentColor" stroke="none"/><path d="M9 18h6"/></svg></div>',
    iconSize: [32, 32],
    iconAnchor: [16, 16]
})

// Fleet overview: last known position of every registered board, in one map.
// GET /api/robot with no deviceId (admin) returns every board's telemetry, so
// just group by device_id and keep each board's most recent row.
async function loadFleetMarkers() {
    clearMarkers()
    try {
        const [robotRes, devicesRes] = await Promise.all([
            fetch('/api/robot', { headers: authHeaders() }),
            fetch('/api/devices', { headers: authHeaders() })
        ])
        const records = await robotRes.json()
        const devices = await devicesRes.json()
        const usernameByUid = {}
        devices.forEach(d => { usernameByUid[d.device_uid] = d.username })

        const latestByDevice = {}
        records.forEach(r => {
            const existing = latestByDevice[r.device_id]
            if (!existing || new Date(r.captured_at) > new Date(existing.captured_at)) {
                latestByDevice[r.device_id] = r
            }
        })

        const positioned = Object.values(latestByDevice).filter(r => r.lat !== null && r.lon !== null)
        positioned.forEach(r => {
            const username = usernameByUid[r.device_id] || r.device_id
            const marker = L.marker([r.lat, r.lon], { icon: robotIcon }).bindPopup(
                `${username}<br>Cập nhật: ${new Date(r.captured_at).toLocaleString('vi-VN')}<br>` +
                `Pin: ${r.battery_pct !== null ? Number(r.battery_pct).toFixed(0) + '%' : '--'}<br>` +
                `Flight mode: ${r.flight_mode || '--'}`
            )
            marker.addTo(map)
            markers.push(marker)
        })

        if (positioned.length > 0) {
            map.fitBounds(L.latLngBounds(positioned.map(r => [r.lat, r.lon])), { padding: [40, 40] })
        }
    } catch (err) {
        console.error('Failed to load fleet positions', err)
    }
}

function recordRowHtml(r) {
    return `
        <td>${r.id}</td>
        <td>${r.device_id}</td>
        <td class="cell-lat">${Number(r.lat).toFixed(6)}</td>
        <td class="cell-lon">${Number(r.lon).toFixed(6)}</td>
        <td class="cell-ph"><span class="ph-chip" style="background:${phColor(r.ph)}">${Number(r.ph).toFixed(2)}</span></td>
        <td class="cell-temp">${r.temp !== null ? Number(r.temp).toFixed(1) : '--'}</td>
        <td class="cell-alk">${r.alk_mgl !== null ? Number(r.alk_mgl).toFixed(1) : '--'}</td>
        <td>${new Date(r.captured_at).toLocaleString('vi-VN')}</td>
        <td class="actions-cell">
            <button class="small-btn edit-btn" data-id="${r.id}">Sửa</button>
            <button class="small-btn danger-btn delete-btn" data-id="${r.id}">Xóa</button>
        </td>
    `
}

function renderStats(records) {
    const bar = document.getElementById('statsBar')
    if (records.length === 0) {
        bar.classList.add('hidden')
        return
    }
    if (currentViewMode === 'table' || currentViewMode === 'map') bar.classList.remove('hidden')

    const avg = (key) => records.reduce((sum, r) => sum + (Number(r[key]) || 0), 0) / records.length
    const latest = records.reduce((a, b) => new Date(a.captured_at) > new Date(b.captured_at) ? a : b)

    document.getElementById('statCount').textContent = records.length
    document.getElementById('statPh').textContent = avg('ph').toFixed(2)
    document.getElementById('statAlk').textContent = avg('alk_mgl').toFixed(1)
    document.getElementById('statLatest').textContent = new Date(latest.captured_at).toLocaleString('vi-VN')
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

    tbody.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => startEditRow(btn.dataset.id, records))
    })
    tbody.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteRecord(btn.dataset.id))
    })
}

function startEditRow(id, records) {
    const record = records.find(r => String(r.id) === String(id))
    const tr = document.querySelector(`tr[data-id="${id}"]`)
    if (!record || !tr) return

    tr.innerHTML = `
        <td>${record.id}</td>
        <td>${record.device_id}</td>
        <td><input type="number" step="any" class="edit-input" id="edit-lat-${id}" value="${record.lat}"></td>
        <td><input type="number" step="any" class="edit-input" id="edit-lon-${id}" value="${record.lon}"></td>
        <td><input type="number" step="any" class="edit-input" id="edit-ph-${id}" value="${record.ph}"></td>
        <td><input type="number" step="any" class="edit-input" id="edit-temp-${id}" value="${record.temp ?? ''}"></td>
        <td><input type="number" step="any" class="edit-input" id="edit-alk-${id}" value="${record.alk_mgl ?? ''}"></td>
        <td>${new Date(record.captured_at).toLocaleString('vi-VN')}</td>
        <td class="actions-cell">
            <button class="small-btn save-btn" data-id="${id}">Lưu</button>
            <button class="small-btn cancel-btn" data-id="${id}">Hủy</button>
        </td>
    `

    tr.querySelector('.save-btn').addEventListener('click', () => saveEditRow(id))
    tr.querySelector('.cancel-btn').addEventListener('click', () => loadBoardData(currentBoardUid))
}

async function saveEditRow(id) {
    const body = {
        lat:     parseFloat(document.getElementById(`edit-lat-${id}`).value),
        lon:     parseFloat(document.getElementById(`edit-lon-${id}`).value),
        ph:      parseFloat(document.getElementById(`edit-ph-${id}`).value),
        temp:    document.getElementById(`edit-temp-${id}`).value === '' ? null : parseFloat(document.getElementById(`edit-temp-${id}`).value),
        alk_mgl: document.getElementById(`edit-alk-${id}`).value === '' ? null : parseFloat(document.getElementById(`edit-alk-${id}`).value)
    }
    try {
        const res = await fetch(`/api/water-quality/${id}`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify(body)
        })
        if (!res.ok) { alert('Lưu thất bại'); return }
        loadBoardData(currentBoardUid)
    } catch (err) {
        alert('Lỗi kết nối server')
    }
}

async function deleteRecord(id) {
    if (!confirm('Xóa record này?')) return
    try {
        const res = await fetch(`/api/water-quality/${id}`, { method: 'DELETE', headers: authHeaders() })
        if (!res.ok) { alert('Xóa thất bại'); return }
        loadBoardData(currentBoardUid)
    } catch (err) {
        alert('Lỗi kết nối server')
    }
}

function renderDevices(devices) {
    const tbody = document.getElementById('devicesBody')
    tbody.innerHTML = ''
    devices.forEach(d => {
        const tr = document.createElement('tr')
        tr.dataset.id = d.id
        tr.innerHTML = `
            <td>${d.id}</td>
            <td>${d.device_uid}</td>
            <td>${d.username}</td>
            <td>••••••</td>
            <td>${new Date(d.created_at).toLocaleString('vi-VN')}</td>
            <td>${new Date(d.updated_at).toLocaleString('vi-VN')}</td>
            <td class="actions-cell">
                <button class="small-btn device-view-btn" data-id="${d.id}">Thông tin</button>
                <button class="small-btn device-detail-btn" data-id="${d.id}">Chi tiết</button>
                <button class="small-btn device-edit-btn" data-id="${d.id}">Sửa</button>
                <button class="small-btn danger-btn device-delete-btn" data-id="${d.id}">Xóa</button>
            </td>
        `
        tbody.appendChild(tr)
    })

    tbody.querySelectorAll('.device-view-btn').forEach(btn => {
        btn.addEventListener('click', () => viewBoardProfile(devices.find(d => String(d.id) === btn.dataset.id).device_uid))
    })
    tbody.querySelectorAll('.device-detail-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const deviceUid = devices.find(d => String(d.id) === btn.dataset.id).device_uid
            window.location.href = `user.html?asDevice=${encodeURIComponent(deviceUid)}`
        })
    })
    tbody.querySelectorAll('.device-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => startEditDevice(btn.dataset.id, devices))
    })
    tbody.querySelectorAll('.device-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteDevice(btn.dataset.id))
    })
}

function startEditDevice(id, devices) {
    const device = devices.find(d => String(d.id) === String(id))
    const tr = document.querySelector(`#devicesBody tr[data-id="${id}"]`)
    if (!device || !tr) return

    tr.innerHTML = `
        <td>${device.id}</td>
        <td><input type="text" class="edit-input edit-input-wide" id="edit-uid-${id}" value="${device.device_uid}"></td>
        <td><input type="text" class="edit-input edit-input-wide" id="edit-username-${id}" value="${device.username}"></td>
        <td><input type="password" class="edit-input edit-input-wide" id="edit-password-${id}" placeholder="(giữ nguyên)"></td>
        <td>${new Date(device.created_at).toLocaleString('vi-VN')}</td>
        <td>${new Date(device.updated_at).toLocaleString('vi-VN')}</td>
        <td class="actions-cell">
            <button class="small-btn device-save-btn" data-id="${id}">Lưu</button>
            <button class="small-btn device-cancel-btn" data-id="${id}">Hủy</button>
        </td>
    `
    tr.querySelector('.device-save-btn').addEventListener('click', () => saveEditDevice(id))
    tr.querySelector('.device-cancel-btn').addEventListener('click', () => loadDevicesList())
}

async function saveEditDevice(id) {
    const deviceUid = document.getElementById(`edit-uid-${id}`).value.trim()
    const username = document.getElementById(`edit-username-${id}`).value.trim()
    const password = document.getElementById(`edit-password-${id}`).value
    const body = { deviceUid, username }
    if (password) body.password = password

    try {
        const res = await fetch(`/api/devices/${id}`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify(body)
        })
        if (!res.ok) { alert('Lưu thất bại'); return }
        loadDevicesList()
    } catch (err) {
        alert('Lỗi kết nối server')
    }
}

async function deleteDevice(id) {
    if (!confirm('Bạn có chắc chắn muốn xóa tài khoản này không? Toàn bộ dữ liệu liên quan có thể sẽ bị mất.')) return
    try {
        const res = await fetch(`/api/devices/${id}`, { method: 'DELETE', headers: authHeaders() })
        if (!res.ok) { alert('Xóa thất bại'); return }
        loadDevicesList()
    } catch (err) {
        alert('Lỗi kết nối server')
    }
}

async function loadDevicesList() {
    try {
        const res = await fetch('/api/devices', { headers: authHeaders() })
        renderDevices(await res.json())
    } catch (err) {
        console.error('Failed to load devices', err)
    }
}

let _lastKnownLatestTs = null

async function loadBoardData(deviceUid) {
    currentBoardUid = deviceUid
    const url = deviceUid ? `/api/water-quality?deviceId=${encodeURIComponent(deviceUid)}` : '/api/water-quality'
    try {
        const res = await fetch(url, { headers: authHeaders() })
        const records = await res.json()
        records.sort((a, b) => a.id - b.id)
        renderTable(records)
        renderMap(records)
        renderStats(records)
        if (records.length > 0) {
            _lastKnownLatestTs = records.reduce((a, b) => new Date(a.captured_at) > new Date(b.captured_at) ? a : b).captured_at
        }
        setNewDataAvailable(false)
    } catch (err) {
        console.error('Failed to load records', err)
    }
}

// Polls for newer records on the currently viewed board than what's loaded —
// raises the yellow header dot instead of auto-refreshing. Only relevant
// while an actual board's data is on screen (table/map), not the board list.
async function checkForNewData() {
    if (!currentBoardUid || !_lastKnownLatestTs) return
    try {
        const res = await fetch(`/api/water-quality?deviceId=${encodeURIComponent(currentBoardUid)}`, { headers: authHeaders() })
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

async function loadAdminInfo() {
    try {
        const res = await fetch('/api/auth/admin-info', { headers: authHeaders() })
        const body = await res.json()
        const el = document.getElementById('adminKeyDisplay')
        if (el) el.value = body.adminKey || '--'
    } catch (err) {
        console.error('Failed to load admin info', err)
    }
}

document.getElementById('adminKeyCopyBtn').addEventListener('click', () => {
    const val = document.getElementById('adminKeyDisplay').value
    if (!val || val === '--') return
    navigator.clipboard.writeText(val).then(() => {
        const btn = document.getElementById('adminKeyCopyBtn')
        btn.textContent = 'Đã sao chép'
        setTimeout(() => { btn.textContent = 'Sao chép' }, 2000)
    })
})

// Shows exactly one of the 5 panes, updates the drawer's active item,
// and shows/hides the stats bar + "back to boards" bar accordingly.
// "info" needs a selected board — if none is selected yet, fall back to "users".
function setViewMode(mode) {
    if (mode === 'info' && !currentBoardUid) {
        showBoardsView()
        return
    }

    currentViewMode = mode
    document.querySelectorAll('.drawer-item').forEach(el => el.classList.toggle('active', el.dataset.view === mode))

    document.getElementById('usersPane').classList.toggle('hidden', mode !== 'users')
    document.getElementById('tablePane').classList.toggle('hidden', mode !== 'table')
    document.getElementById('mapPane').classList.toggle('hidden', mode !== 'map')
    document.getElementById('infoPane').classList.toggle('hidden', mode !== 'info')
    document.getElementById('adminInfoPane').classList.toggle('hidden', mode !== 'adminProfile')

    // statsBar/boardContextBar are for the per-board drill-down (table/info)
    // only — "map" is now the fleet-wide overview, no board context needed.
    document.getElementById('statsBar').classList.toggle('hidden', mode !== 'table')
    document.getElementById('boardContextBar').classList.toggle('hidden', mode !== 'table' && mode !== 'info')

    if (mode === 'users') {
        loadDevicesList()
    } else if (mode === 'map') {
        setTimeout(() => map.invalidateSize(), 50)
        loadFleetMarkers()
    } else if (mode === 'info') {
        loadProfileReadOnly()
    } else if (mode === 'adminProfile') {
        loadAdminInfo()
    }
    closeDrawer()
}

async function loadProfileReadOnly() {
    if (!currentBoardUid) return
    try {
        const res = await fetch(`/api/profile?deviceUid=${encodeURIComponent(currentBoardUid)}`, { headers: authHeaders() })
        const profile = await res.json()
        document.getElementById('viewHo').textContent = (profile && profile.ho) || '--'
        document.getElementById('viewTen').textContent = (profile && profile.ten) || '--'
        document.getElementById('viewPhone').textContent = (profile && profile.phone) || '--'
        document.getElementById('viewAddress').textContent = (profile && profile.address) || '--'
        document.getElementById('viewSupplier').textContent = (profile && profile.supplier) || '--'
        document.getElementById('viewDeviceUid').textContent = currentBoardUid
    } catch (err) {
        console.error('Failed to load profile', err)
    }
}

function showBoardsView() {
    currentBoardUid = null
    setNewDataAvailable(false)
    setViewMode('users')
}

function viewBoardProfile(deviceUid) {
    currentBoardUid = deviceUid
    setViewMode('info')
}

document.getElementById('backToBoardsBtn').addEventListener('click', showBoardsView)

document.querySelectorAll('.drawer-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault()
        const view = item.dataset.view
        // "info" is a per-board drill-down (profile) — needs a board picked
        // first. "map" is the Fleet overview now, no board selection needed.
        if (view === 'info' && !currentBoardUid) {
            showBoardsView()
        } else {
            setViewMode(view)
        }
    })
})

document.getElementById('refreshBtn').addEventListener('click', () => {
    if (currentViewMode === 'users') {
        loadDevicesList()
    } else if (currentViewMode === 'table' || currentViewMode === 'map') {
        loadBoardData(currentBoardUid)
    } else if (currentViewMode === 'info') {
        loadProfileReadOnly()
    }
})

initSession('admin', () => {
    showBoardsView()
})
