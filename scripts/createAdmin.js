require('dotenv').config()
const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const pool = require('../src/db')

async function main() {
    const [username, password, adminKeyArg] = process.argv.slice(2)
    if (!username || !password) {
        console.error('Usage: npm run create-admin -- <username> <password> [adminKey]')
        console.error('  adminKey: bỏ trống để tự sinh ngẫu nhiên')
        process.exit(1)
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const adminKey = adminKeyArg || crypto.randomBytes(24).toString('hex')

    await pool.query(
        `INSERT INTO admins (username, password_hash, admin_key) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), admin_key = VALUES(admin_key)`,
        [username, passwordHash, adminKey]
    )

    console.log(`Admin "${username}" đã được tạo/cập nhật`)
    console.log(`Admin key (dùng để đăng ký board mới): ${adminKey}`)
    process.exit(0)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
