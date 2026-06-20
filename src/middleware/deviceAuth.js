const bcrypt = require('bcryptjs')
const pool = require('../db')

// Used by POST /batch — the request must come from the exact device (by hardware
// UID) that the username/password are registered to.
async function requireDeviceAuth(req, res, next) {
    const username  = req.headers['x-username']
    const password  = req.headers['x-password']
    const deviceUid = req.body && req.body.deviceId

    if (!username || !password || !deviceUid) {
        return res.status(401).json({ error: 'Missing device credentials' })
    }

    try {
        const [rows] = await pool.query(
            'SELECT password_hash FROM devices WHERE device_uid = ? AND username = ?',
            [deviceUid, username]
        )
        if (rows.length === 0 || !(await bcrypt.compare(password, rows[0].password_hash))) {
            return res.status(401).json({ error: 'Unknown device or invalid credentials' })
        }
        next()
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Auth check failed' })
    }
}

// Checks username/password against the `admins` table — see scripts/createAdmin.js
async function _checkAdminCredentials(username, password) {
    if (!username || !password) return false
    const [rows] = await pool.query('SELECT password_hash FROM admins WHERE username = ?', [username])
    if (rows.length === 0) return false
    return bcrypt.compare(password, rows[0].password_hash)
}

// Web dashboard admin account (manage all boards, edit/delete data) — stored in
// the `admins` table, not .env. Create one via `npm run create-admin`.
async function requireAdminAuth(req, res, next) {
    try {
        if (!(await _checkAdminCredentials(req.headers['x-username'], req.headers['x-password']))) {
            return res.status(401).json({ error: 'Admin access required' })
        }
        next()
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Auth check failed' })
    }
}

// Web dashboard data viewing — admin sees everything (req.isAdmin = true), a
// regular board account is scoped to its own device_uid (req.deviceUid).
async function requireViewAuth(req, res, next) {
    const username = req.headers['x-username']
    const password = req.headers['x-password']

    if (!username || !password) {
        return res.status(401).json({ error: 'Login required' })
    }

    try {
        if (await _checkAdminCredentials(username, password)) {
            req.isAdmin = true
            return next()
        }

        const [rows] = await pool.query(
            'SELECT password_hash, device_uid FROM devices WHERE username = ?',
            [username]
        )
        if (rows.length === 0 || !(await bcrypt.compare(password, rows[0].password_hash))) {
            return res.status(401).json({ error: 'Invalid credentials' })
        }
        req.deviceUid = rows[0].device_uid
        next()
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Auth check failed' })
    }
}

module.exports = { requireDeviceAuth, requireAdminAuth, requireViewAuth }
