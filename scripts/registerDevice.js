require('dotenv').config()
const bcrypt = require('bcryptjs')
const pool = require('../src/db')

async function main() {
    const [deviceUid, username, password] = process.argv.slice(2)
    if (!deviceUid || !username || !password) {
        console.error('Usage: npm run register-device -- <robot_id> <username> <password>')
        console.error('  robot_id: copy from QGC -> Kết nối -> Robot ID (e.g. S16S-01, set via SA_ROBOT_ID param)')
        process.exit(1)
    }

    const passwordHash = await bcrypt.hash(password, 10)
    await pool.query(
        `INSERT INTO devices (device_uid, username, password_hash) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE username = VALUES(username), password_hash = VALUES(password_hash)`,
        [deviceUid, username, passwordHash]
    )

    console.log(`Registered device "${deviceUid}" with username "${username}"`)
    process.exit(0)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
