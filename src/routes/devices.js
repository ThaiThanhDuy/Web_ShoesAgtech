const express = require('express')
const router = express.Router()
const bcrypt = require('bcryptjs')
const pool = require('../db')
const { requireAdminAuth } = require('../middleware/deviceAuth')

// Each admin has their own admin_key (see scripts/createAdmin.js) — any valid one works.
async function requireAdminKey(req, res, next) {
    const key = req.headers['x-admin-key']
    if (!key) {
        return res.status(401).json({ error: 'Invalid admin key' })
    }
    try {
        const [rows] = await pool.query('SELECT id FROM admins WHERE admin_key = ?', [key])
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid admin key' })
        }
        next()
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Auth check failed' })
    }
}

// POST /api/devices/register
// Header: x-admin-key. Body: { deviceUid, username, password }
// Registers (or updates) the account a board uses to sync — see server/README.md.
router.post('/register', requireAdminKey, async (req, res) => {
    const { deviceUid, username, password } = req.body || {}

    if (!deviceUid || !username || !password) {
        return res.status(400).json({ error: 'deviceUid, username and password are required' })
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10)
        await pool.query(
            `INSERT INTO devices (device_uid, username, password_hash) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE username = VALUES(username), password_hash = VALUES(password_hash)`,
            [deviceUid, username, passwordHash]
        )
        res.json({ ok: true })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// GET /api/devices — list registered boards (no passwords returned). Admin-only.
router.get('/', requireAdminAuth, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, device_uid, username, created_at, updated_at FROM devices ORDER BY created_at DESC'
        )
        res.json(rows)
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// PUT /api/devices/:id — admin-only edit (deviceUid, username always updated;
// password only changed if a new one is given)
// Body: { deviceUid, username, password? }
router.put('/:id', requireAdminAuth, async (req, res) => {
    const { deviceUid, username, password } = req.body || {}
    if (!deviceUid || !username) {
        return res.status(400).json({ error: 'deviceUid and username are required' })
    }

    try {
        if (password) {
            const passwordHash = await bcrypt.hash(password, 10)
            await pool.query(
                'UPDATE devices SET device_uid = ?, username = ?, password_hash = ? WHERE id = ?',
                [deviceUid, username, passwordHash, req.params.id]
            )
        } else {
            await pool.query(
                'UPDATE devices SET device_uid = ?, username = ? WHERE id = ?',
                [deviceUid, username, req.params.id]
            )
        }
        res.json({ ok: true })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// DELETE /api/devices/:id — admin-only. Does not touch that board's past rows in DATA.
router.delete('/:id', requireAdminAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM devices WHERE id = ?', [req.params.id])
        res.json({ deleted: true })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

module.exports = router
