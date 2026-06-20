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

// POST /api/water-quality/batch
// Headers: x-username, x-password (must match the device_uid in the body — see scripts/registerDevice.js)
// Body: { deviceId: string (hardware UID), records: [{ idx, lat, lon, alt, phAm, phPm, temp, alkTgt, alkMgl, ts }] }
// phAm/phPm: only one set per record (split by local hour-of-day at capture).
// alkTgt: firmware's real-time alkMgl, always present. alkMgl: only set by QGC
// when firmware reported slotStatus=FULL (ΔpH-validated, more accurate) — see
// Shoes_agtech_data_sync.md.
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

    try {
        let inserted = 0
        let updated = 0

        for (const r of records) {
            const capturedAt = r.ts ? new Date(r.ts) : new Date()
            const [candidates] = await pool.query(
                `SELECT id, lat, lon FROM \`DATA\` WHERE device_id = ?
                 AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
                [devId, r.lat - DEDUP_BBOX_DEG, r.lat + DEDUP_BBOX_DEG, r.lon - DEDUP_BBOX_DEG, r.lon + DEDUP_BBOX_DEG]
            )

            let closestId = null
            let closestDist = Infinity
            for (const c of candidates) {
                const dist = haversineMeters(r.lat, r.lon, c.lat, c.lon)
                if (dist <= DEDUP_RADIUS_M && dist < closestDist) {
                    closestId = c.id
                    closestDist = dist
                }
            }

            if (closestId !== null) {
                await pool.query(
                    `UPDATE \`DATA\` SET wp_idx = ?, lat = ?, lon = ?, alt = ?,
                        ph_am = ?, ph_pm = ?, temp = ?, alk_tgt = ?, alk_mgl = ?, captured_at = ?
                     WHERE id = ?`,
                    [r.idx, r.lat, r.lon, r.alt ?? null, r.phAm ?? null, r.phPm ?? null,
                     r.temp ?? null, r.alkTgt ?? null, r.alkMgl ?? null, capturedAt, closestId]
                )
                updated++
            } else {
                await pool.query(
                    `INSERT INTO \`DATA\`
                        (device_id, wp_idx, lat, lon, alt, ph_am, ph_pm, temp, alk_tgt, alk_mgl, captured_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [devId, r.idx, r.lat, r.lon, r.alt ?? null, r.phAm ?? null, r.phPm ?? null,
                     r.temp ?? null, r.alkTgt ?? null, r.alkMgl ?? null, capturedAt]
                )
                inserted++
            }
        }

        res.json({ inserted, updated })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// POST /api/water-quality/login
// Headers: x-username, x-password. Body: { deviceId }
// Lets QGC verify the account/device pairing before any actual data exists to sync.
router.post('/login', requireDeviceAuth, (req, res) => {
    res.json({ ok: true })
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
// Body: { lat, lon, ph_am, ph_pm, temp, alk_tgt, alk_mgl }
router.put('/:id', requireAdminAuth, async (req, res) => {
    const { lat, lon, ph_am, ph_pm, temp, alk_tgt, alk_mgl } = req.body || {}
    try {
        await pool.query(
            'UPDATE `DATA` SET lat = ?, lon = ?, ph_am = ?, ph_pm = ?, temp = ?, alk_tgt = ?, alk_mgl = ? WHERE id = ?',
            [lat, lon, ph_am ?? null, ph_pm ?? null, temp ?? null, alk_tgt ?? null, alk_mgl ?? null, req.params.id]
        )
        res.json({ ok: true })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// DELETE /api/water-quality/:id — admin-only
router.delete('/:id', requireAdminAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM `DATA` WHERE id = ?', [req.params.id])
        res.json({ deleted: true })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

module.exports = router
