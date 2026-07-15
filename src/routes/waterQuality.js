const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireDeviceAuth, requireAdminAuth, requireViewAuth } = require('../middleware/deviceAuth')

const DEDUP_RADIUS_M = 1.5
// Generous lat/lon prefilter before the exact haversine check below — 0.0001°
// is ~11m at the equator, comfortably wider than DEDUP_RADIUS_M so no real
// match is missed, while still letting the DB use the lat/lon index range scan.
const DEDUP_BBOX_DEG = 0.0001

function haversineMeters(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180
    const R = 6371000
    const dLat = toRad(lat2 - lat1)
    const dLon = toRad(lon2 - lon1)
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(a))
}

// Renumbers every row's id 1..N in chronological order (captured_at ASC) on
// `conn` (caller owns the transaction) — keeps id a clean dense sequence that
// always matches capture order, called after every batch sync AND every
// delete (see POST /batch and DELETE /:id below). Bumps everything out of the
// low range first since id is the PRIMARY KEY — renumbering straight to 1..N
// in one pass can transiently collide with another row's still-original id.
async function _renumberDataIds(conn) {
    await conn.query('UPDATE `DATA` SET id = id + 1000000')
    await conn.query('SET @_rn = 0')
    await conn.query('UPDATE `DATA` SET id = (@_rn := @_rn + 1) ORDER BY captured_at ASC')
    const [countRows] = await conn.query('SELECT COUNT(*) AS cnt FROM `DATA`')
    return countRows[0].cnt
}

// POST /api/water-quality/batch
// Headers: x-username, x-password (must match the device_uid in the body — see scripts/registerDevice.js)
// Body: { deviceId: string (hardware UID), records: [{ idx, lat, lon, alt, phAm, phPm, deltaPh, temp, alkTgt, alkMgl, ts }] }
// phAm/phPm: QGC fills both once a point has been visited twice today (see
// Shoes_agtech_data_sync.md) — otherwise only one is set. deltaPh/alkMgl are
// only set once both phAm/phPm are present (ΔpH-validated, more accurate);
// alkTgt is firmware's real-time alkMgl, always present.
//
// Dedup: if an existing row for this device is within DEDUP_RADIUS_M of the
// incoming point, that row is UPDATEd in place (revisit of the same spot)
// instead of inserting a new row — keeps the table from growing one row per
// revisit of a stationary/repeated sampling point.
router.post('/batch', requireDeviceAuth, async (req, res) => {
    const { deviceId, records } = req.body || {}

    if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: 'records must be a non-empty array' })
    }

    const devId = deviceId || 'unknown'
    const conn  = await pool.getConnection()

    try {
        await conn.beginTransaction()

        let inserted = 0
        let updated  = 0

        const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

        // Batch dedup: 1 SELECT covers all incoming records instead of 1 per record,
        // then pond/distance checks happen in JS using the pre-fetched map.
        const validRecs = records.filter(r => r.lat != null && r.lon != null)
        const existByDay = {}
        if (validRecs.length > 0) {
            const dates  = [...new Set(validRecs.map(r => fmtDate(r.ts ? new Date(r.ts) : new Date())))]
            const minLat = Math.min(...validRecs.map(r => r.lat)) - DEDUP_BBOX_DEG
            const maxLat = Math.max(...validRecs.map(r => r.lat)) + DEDUP_BBOX_DEG
            const minLon = Math.min(...validRecs.map(r => r.lon)) - DEDUP_BBOX_DEG
            const maxLon = Math.max(...validRecs.map(r => r.lon)) + DEDUP_BBOX_DEG
            const datePh = dates.map(() => '?').join(',')
            const [existing] = await conn.query(
                `SELECT id, lat, lon, pond_idx, DATE(captured_at) AS day FROM \`DATA\`
                 WHERE device_id = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
                 AND DATE(captured_at) IN (${datePh})`,
                [devId, minLat, maxLat, minLon, maxLon, ...dates]
            )
            existing.forEach(row => {
                const key = row.day instanceof Date ? fmtDate(row.day) : String(row.day)
                if (!existByDay[key]) existByDay[key] = []
                existByDay[key].push(row)
            })
        }

        for (const r of records) {
            const capturedAt = r.ts ? new Date(r.ts) : new Date()
            const dayKey     = fmtDate(capturedAt)

            let closestId   = null
            let closestDist = Infinity
            for (const c of (existByDay[dayKey] || [])) {
                const dist = haversineMeters(r.lat, r.lon, c.lat, c.lon)
                if (dist <= DEDUP_RADIUS_M && dist < closestDist) {
                    closestId = c.id
                    closestDist = dist
                }
            }

            if (closestId !== null) {
                const existRow  = (existByDay[dayKey] || []).find(c => c.id === closestId)
                const existPond = existRow?.pond_idx ?? null
                const newPond   = r.pondIdx ?? null
                if (existPond !== null && newPond !== null && Number(existPond) !== Number(newPond)) {
                    closestId = null
                }
            }

            if (closestId !== null) {
                await conn.query(
                    `UPDATE \`DATA\` SET wp_idx = ?, lat = ?, lon = ?, alt = ?,
                        ph_am = ?, ph_pm = ?, delta_ph = ?, temp = ?,
                        alk_tgt = ?, alk_dkh = ?, alk_mgl = ?, pond_idx = ?, captured_at = ?
                     WHERE id = ?`,
                    [r.idx, r.lat, r.lon, r.alt ?? null, r.phAm ?? null, r.phPm ?? null, r.deltaPh ?? null,
                     r.temp ?? null, r.alkTgt ?? null, r.alkDkh ?? null, r.alkMgl ?? null, r.pondIdx ?? null,
                     capturedAt, closestId]
                )
                updated++
            } else {
                await conn.query(
                    `INSERT INTO \`DATA\`
                        (device_id, wp_idx, lat, lon, alt, ph_am, ph_pm, delta_ph, temp,
                         alk_tgt, alk_dkh, alk_mgl, pond_idx, captured_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [devId, r.idx, r.lat, r.lon, r.alt ?? null, r.phAm ?? null, r.phPm ?? null, r.deltaPh ?? null,
                     r.temp ?? null, r.alkTgt ?? null, r.alkDkh ?? null, r.alkMgl ?? null, r.pondIdx ?? null,
                     capturedAt]
                )
                inserted++
            }
        }

        await conn.commit()
        res.json({ inserted, updated })
    } catch (err) {
        await conn.rollback()
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    } finally {
        conn.release()
    }
})

// POST /api/water-quality/login
// Headers: x-username, x-password. Body: { deviceId }
// Lets QGC verify the account/device pairing before any actual data exists to sync.
router.post('/login', requireDeviceAuth, (req, res) => {
    res.json({ ok: true })
})

// GET /api/water-quality/latest — returns the single most-recent row (for lightweight polling).
router.get('/latest', requireViewAuth, async (req, res) => {
    const deviceId = req.isAdmin ? req.query.deviceId : req.deviceUid
    const where  = []
    const params = []
    if (deviceId) { where.push('device_id = ?'); params.push(deviceId) }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    try {
        const [rows] = await pool.query(
            `SELECT captured_at FROM \`DATA\` ${whereSql} ORDER BY captured_at DESC LIMIT 1`,
            params
        )
        res.json(rows[0] || null)
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// GET /api/water-quality?deviceId=&from=&to=
// Headers: x-username, x-password. Admin sees any/all deviceId; a board account is
// always force-scoped to its own device_uid (deviceId param is ignored for it).
router.get('/', requireViewAuth, async (req, res) => {
    const { from, to } = req.query
    const deviceId = req.isAdmin ? req.query.deviceId : req.deviceUid
    const where  = []
    const params = []

    if (deviceId) { where.push('device_id = ?');   params.push(deviceId) }
    if (from)     { where.push('captured_at >= ?'); params.push(from) }
    if (to)       { where.push('captured_at <= ?'); params.push(to) }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    try {
        const [rows] = await pool.query(
            `SELECT * FROM \`DATA\` ${whereSql} ORDER BY captured_at DESC LIMIT 2000`,
            params
        )
        res.json(rows)
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// PUT /api/water-quality/:id — admin-only edit
// Body: { lat, lon, ph_am, ph_pm, delta_ph, temp, alk_tgt, alk_dkh, alk_mgl, pond_idx }
router.put('/:id', requireAdminAuth, async (req, res) => {
    const { lat, lon, ph_am, ph_pm, delta_ph, temp, alk_tgt, alk_dkh, alk_mgl, pond_idx } = req.body || {}
    try {
        await pool.query(
            'UPDATE `DATA` SET lat = ?, lon = ?, ph_am = ?, ph_pm = ?, delta_ph = ?, temp = ?, alk_tgt = ?, alk_dkh = ?, alk_mgl = ?, pond_idx = ? WHERE id = ?',
            [lat, lon, ph_am ?? null, ph_pm ?? null, delta_ph ?? null, temp ?? null, alk_tgt ?? null, alk_dkh ?? null, alk_mgl ?? null, pond_idx ?? null, req.params.id]
        )
        res.json({ ok: true })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// DELETE /api/water-quality/:id — admin-only (a board account's user.js shows
// "liên hệ admin để xóa" instead of calling this). After deleting, renumbers
// every remaining row's id 1..N in chronological order (captured_at ASC) so
// the id column stays a clean dense sequence instead of leaving a gap.
router.delete('/:id', requireAdminAuth, async (req, res) => {
    const conn = await pool.getConnection()
    try {
        await conn.beginTransaction()
        await conn.query('DELETE FROM `DATA` WHERE id = ?', [req.params.id])

        const count = await _renumberDataIds(conn)
        await conn.commit()

        // ALTER TABLE issues an implicit commit in InnoDB anyway, so it can't
        // join the transaction above — run it after; worst case on failure is
        // a cosmetic AUTO_INCREMENT gap, not a broken id sequence.
        await conn.query('ALTER TABLE `DATA` AUTO_INCREMENT = ?', [count + 1])

        res.json({ deleted: true })
    } catch (err) {
        await conn.rollback()
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    } finally {
        conn.release()
    }
})

module.exports = router
