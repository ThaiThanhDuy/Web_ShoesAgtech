const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireDeviceAuth, requireAdminAuth, requireViewAuth } = require('../middleware/deviceAuth')

async function _ensureTable(conn) {
    await conn.query(`
        CREATE TABLE IF NOT EXISTS FEEDING_DATA (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            device_id   VARCHAR(64) NOT NULL,
            pond_idx    INT,
            buoi        VARCHAR(20),
            food_kg     FLOAT,
            feedback    VARCHAR(100),
            decision    VARCHAR(100),
            route       VARCHAR(100),
            captured_at DATETIME NOT NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_device_captured (device_id, captured_at)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `)
}

async function _renumberIds(conn) {
    await conn.query('UPDATE FEEDING_DATA SET id = id + 1000000')
    await conn.query('SET @_rn = 0')
    await conn.query('UPDATE FEEDING_DATA SET id = (@_rn := @_rn + 1) ORDER BY captured_at ASC')
    const [countRows] = await conn.query('SELECT COUNT(*) AS cnt FROM FEEDING_DATA')
    return countRows[0].cnt
}

// Ensure table exists once at module load — removes the need to call _ensureTable
// on every GET request (which was the primary waste).
;(async () => {
    try {
        const c = await pool.getConnection()
        await _ensureTable(c)
        c.release()
    } catch (e) {
        console.warn('FEEDING_DATA table init warning:', e.message)
    }
})()

// POST /api/feeding/batch
// Headers: x-username, x-password (device account)
// Body: { deviceId, records: [{ts, robot, pondIdx, buoi, foodKg, feedback, decision, route}] }
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

        for (const r of records) {
            const capturedAt = r.ts ? new Date(r.ts) : new Date()
            await conn.query(
                `INSERT INTO FEEDING_DATA
                    (device_id, pond_idx, buoi, food_kg, feedback, decision, route, captured_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [devId, r.pondIdx ?? null, r.buoi ?? null, r.foodKg ?? null,
                 r.feedback ?? null, r.decision ?? null, r.route ?? null, capturedAt]
            )
            inserted++
        }

        await conn.commit()

        res.json({ inserted })
    } catch (err) {
        await conn.rollback()
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    } finally {
        conn.release()
    }
})

// GET /api/feeding?deviceId=&from=&to=
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
            `SELECT * FROM FEEDING_DATA ${whereSql} ORDER BY captured_at DESC LIMIT 2000`,
            params
        )
        res.json(rows)
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    }
})

// DELETE /api/feeding/:id  (admin only)
router.delete('/:id', requireAdminAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' })

    const conn = await pool.getConnection()
    try {
        await conn.beginTransaction()
        const [result] = await conn.query('DELETE FROM FEEDING_DATA WHERE id = ?', [id])
        if (result.affectedRows === 0) {
            await conn.rollback()
            return res.status(404).json({ error: 'Not found' })
        }
        await _renumberIds(conn)
        await conn.commit()
        res.json({ ok: true })
    } catch (err) {
        await conn.rollback()
        console.error(err)
        res.status(500).json({ error: 'Database error' })
    } finally {
        conn.release()
    }
})

module.exports = router
