const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireDeviceAuth, requireViewAuth } = require('../middleware/deviceAuth')

// POST /api/robot/batch
// Headers: x-username, x-password (must match the device_uid in the body — see scripts/registerDevice.js)
// Body: { deviceId: string (hardware UID), records: [{ battery, gpsFix, gpsSats, flightMode, speed, throttle, lat, lon, ts }] }
// Sent automatically in the background by QGC (DataShoesAgtech.qml) — no manual sync button.
router.post('/batch', requireDeviceAuth, async (req, res) => {
    const { deviceId, records } = req.body || {}

    if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: 'records must be a non-empty array' })
    }

    const values = records.map(r => [
        deviceId || 'unknown',
        r.battery ?? null,
        r.gpsFix ?? null,
        r.gpsSats ?? null,
        r.flightMode ?? null,
        r.speed ?? null,
        r.throttle ?? null,
        r.lat ?? null,
        r.lon ?? null,
        r.ts ? new Date(r.ts) : new Date()
    ])

    try {
        const sql = `INSERT INTO robot_telemetry
            (device_id, battery_pct, gps_fix, gps_sats, flight_mode, speed_mps, throttle_pct, lat, lon, captured_at)
            VALUES ?`
        const [result] = await pool.query(sql, [values])
        res.json({ inserted: result.affectedRows })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// GET /api/robot?deviceId=&from=&to=
// Headers: x-username, x-password. Admin sees any/all deviceId; a board account is
// always force-scoped to its own device_uid (deviceId param is ignored for it).
router.get('/', requireViewAuth, async (req, res) => {
    const { from, to } = req.query
    const deviceId = req.isAdmin ? req.query.deviceId : req.deviceUid
    const where  = []
    const params = []

    if (deviceId) { where.push('device_id = ?');    params.push(deviceId) }
    if (from)     { where.push('captured_at >= ?');  params.push(from) }
    if (to)       { where.push('captured_at <= ?');  params.push(to) }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    try {
        const [rows] = await pool.query(
            `SELECT * FROM robot_telemetry ${whereSql} ORDER BY captured_at DESC LIMIT 5000`,
            params
        )
        res.json(rows)
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

module.exports = router
