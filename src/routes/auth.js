const express = require('express')
const router = express.Router()
const bcrypt = require('bcryptjs')
const pool = require('../db')

// POST /api/auth/login — web dashboard login (admin or a registered board account)
// Body: { username, password }
router.post('/login', async (req, res) => {
    const { username, password } = req.body || {}
    if (!username || !password) {
        return res.status(400).json({ error: 'username và password là bắt buộc' })
    }

    try {
        const [adminRows] = await pool.query(
            'SELECT password_hash FROM admins WHERE username = ?',
            [username]
        )
        if (adminRows.length > 0 && await bcrypt.compare(password, adminRows[0].password_hash)) {
            return res.json({ role: 'admin', username })
        }

        const [rows] = await pool.query(
            'SELECT password_hash, device_uid FROM devices WHERE username = ?',
            [username]
        )
        if (rows.length === 0 || !(await bcrypt.compare(password, rows[0].password_hash))) {
            return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' })
        }
        res.json({ role: 'device', username, deviceUid: rows[0].device_uid })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// PUT /api/auth/password — change the currently authenticated account's own password
// (works for both an admin account and a regular board account).
// Headers: x-username, x-password (current credentials). Body: { newPassword }
router.put('/password', async (req, res) => {
    const username = req.headers['x-username']
    const currentPassword = req.headers['x-password']
    const { newPassword } = req.body || {}

    if (!username || !currentPassword) {
        return res.status(401).json({ error: 'Login required' })
    }
    if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 4 ký tự' })
    }

    try {
        const [adminRows] = await pool.query('SELECT password_hash FROM admins WHERE username = ?', [username])
        if (adminRows.length > 0) {
            if (!(await bcrypt.compare(currentPassword, adminRows[0].password_hash))) {
                return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' })
            }
            const newHash = await bcrypt.hash(newPassword, 10)
            await pool.query('UPDATE admins SET password_hash = ? WHERE username = ?', [newHash, username])
            return res.json({ ok: true })
        }

        const [deviceRows] = await pool.query('SELECT password_hash FROM devices WHERE username = ?', [username])
        if (deviceRows.length === 0 || !(await bcrypt.compare(currentPassword, deviceRows[0].password_hash))) {
            return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng' })
        }
        const newHash = await bcrypt.hash(newPassword, 10)
        await pool.query('UPDATE devices SET password_hash = ? WHERE username = ?', [newHash, username])
        res.json({ ok: true })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

module.exports = router
