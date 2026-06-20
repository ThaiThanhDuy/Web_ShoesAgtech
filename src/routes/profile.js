const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireViewAuth } = require('../middleware/deviceAuth')

// GET /api/profile — a board sees its own profile; admin must pass ?deviceUid=
// to view a specific board's profile (read-only, no edit/delete for admin).
router.get('/', requireViewAuth, async (req, res) => {
    const deviceUid = req.isAdmin ? req.query.deviceUid : req.deviceUid
    if (!deviceUid) {
        return res.status(400).json({ error: 'deviceUid is required' })
    }
    try {
        const [rows] = await pool.query('SELECT * FROM device_profiles WHERE device_uid = ?', [deviceUid])
        res.json(rows[0] || null)
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// PUT /api/profile — a board edits its own profile; admin can edit any board's
// profile by passing { deviceUid } in the body (used by admin's "Chi tiết" page).
router.put('/', requireViewAuth, async (req, res) => {
    const deviceUid = req.isAdmin ? req.body.deviceUid : req.deviceUid
    if (!deviceUid) {
        return res.status(403).json({ error: 'deviceUid is required' })
    }
    const { ho, ten, phone, address, supplier } = req.body || {}
    try {
        await pool.query(
            `INSERT INTO device_profiles (device_uid, ho, ten, phone, address, supplier)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE ho = VALUES(ho), ten = VALUES(ten), phone = VALUES(phone),
                 address = VALUES(address), supplier = VALUES(supplier)`,
            [deviceUid, ho || null, ten || null, phone || null, address || null, supplier || null]
        )
        res.json({ ok: true })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// DELETE /api/profile?deviceUid= — a board clears its own profile; admin can
// clear any board's profile by passing ?deviceUid= (admin's "Chi tiết" page).
router.delete('/', requireViewAuth, async (req, res) => {
    const deviceUid = req.isAdmin ? req.query.deviceUid : req.deviceUid
    if (!deviceUid) {
        return res.status(403).json({ error: 'deviceUid is required' })
    }
    try {
        await pool.query('DELETE FROM device_profiles WHERE device_uid = ?', [deviceUid])
        res.json({ deleted: true })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

module.exports = router
