const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireDeviceAuth, requireViewAuth } = require('../middleware/deviceAuth')

// SECURITY: col and def must be caller-controlled constants — not safe for user-supplied input.
async function _addColIfMissing(col, def) {
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'robot_telemetry' AND COLUMN_NAME = ?`,
        [col]
    )
    if (rows[0].cnt === 0) {
        await pool.query(`ALTER TABLE robot_telemetry ADD COLUMN ${col} ${def}`)
    }
}

async function _migrate() {
    try {
        await _addColIfMissing('mission_dist_m', 'INT DEFAULT NULL')
        await _addColIfMissing('actual_dist_m',  'INT DEFAULT NULL')
    } catch (e) {
        console.warn('robot_telemetry migration warning:', e.message)
    }
}
_migrate()

// POST /api/robot/batch
// Headers: x-username, x-password (must match the device_uid in the body — see scripts/registerDevice.js)
// Body: { deviceId: string (hardware UID), records: [{ battery, gpsFix, gpsSats, flightMode, speed, throttle, lat, lon, missionDistM, actualDistM, ts }] }
// Sent automatically in the background by QGC (DataShoesAgtech.qml) — no manual sync button.
router.post('/batch', requireDeviceAuth, async (req, res) => {
    const { deviceId, records } = req.body || {}

    if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: 'records must be a non-empty array' })
    }

    const values = records.map(r => [
        r.robot ?? deviceId ?? 'unknown',
        r.battery ?? null,
        r.gpsFix ?? null,
        r.gpsSats ?? null,
        r.flightMode ?? null,
        r.speed ?? null,
        r.throttle ?? null,
        r.lat ?? null,
        r.lon ?? null,
        r.missionDistM ?? null,
        r.actualDistM  ?? null,
        r.ts ? new Date(r.ts) : new Date()
    ])

    try {
        const sql = `INSERT INTO robot_telemetry
            (device_id, battery_pct, gps_fix, gps_sats, flight_mode, speed_mps, throttle_pct, lat, lon, mission_dist_m, actual_dist_m, captured_at)
            VALUES ?`
        const [result] = await pool.query(sql, [values])
        res.json({ inserted: result.affectedRows })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// GET /api/robot?deviceId=&from=&to=&days=N
// Headers: x-username, x-password. Admin sees any/all deviceId; a board account is
// always force-scoped to its own device_uid (deviceId param is ignored for it).
// Pass ?days=N (e.g. days=30) to limit to the last N calendar days when no explicit
// from/to range is given — keeps payload small for the default daily-summary view.
router.get('/', requireViewAuth, async (req, res) => {
    const { from, to, days } = req.query
    const deviceId = req.isAdmin ? req.query.deviceId : req.deviceUid
    const where  = []
    const params = []

    if (deviceId) { where.push('device_id = ?');    params.push(deviceId) }
    if (from)     { where.push('captured_at >= ?');  params.push(from) }
    if (to)       { where.push('captured_at <= ?');  params.push(to) }
    if (days && !from && !to) {
        where.push('captured_at >= DATE_SUB(NOW(), INTERVAL ? DAY)')
        params.push(Math.max(1, parseInt(days, 10) || 30))
    }

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
