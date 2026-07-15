let session = JSON.parse(localStorage.getItem('wqSession') || 'null')
let isRegisterMode = false

function roleHomePage(role) {
    return role === 'admin' ? 'admin.html' : 'user.html'
}

function setRegisterMode(on) {
    isRegisterMode = on
    document.getElementById('registerExtraFields').classList.toggle('hidden', !on)
    document.getElementById('loginTitle').textContent = on ? 'Đăng ký board mới' : 'Đăng nhập'
    document.getElementById('loginSubmitBtn').textContent = on ? 'Đăng ký' : 'Đăng nhập'
    document.getElementById('toggleRegisterLink').textContent = on ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký board mới'
    document.getElementById('loginMsg').textContent = ''
}

document.getElementById('toggleRegisterLink').addEventListener('click', (e) => {
    e.preventDefault()
    setRegisterMode(!isRegisterMode)
})

document.getElementById('loginSubmitBtn').addEventListener('click', async () => {
    const username = document.getElementById('loginUsername').value.trim()
    const password = document.getElementById('loginPassword').value
    const msg = document.getElementById('loginMsg')

    if (!username || !password) {
        msg.textContent = 'Điền username và password'
        msg.className = 'error'
        return
    }

    if (isRegisterMode) {
        const robotType = document.getElementById('loginRobotType').value
        const robotNumRaw = document.getElementById('loginRobotNum').value.trim()
        const adminKey  = document.getElementById('loginAdminKey').value
        const robotNum  = parseInt(robotNumRaw, 10)
        if (!robotType || robotNumRaw === '' || isNaN(robotNum) || robotNum < 0 || robotNum > 999 || !adminKey) {
            msg.textContent = 'Chọn loại robot, nhập ID (0–999) và Admin key'
            msg.className = 'error'
            return
        }
        const idStr     = robotNum < 10 ? '0' + robotNum : '' + robotNum
        const deviceUid = robotType + '-' + idStr
        try {
            const res = await fetch('/api/devices/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
                body: JSON.stringify({ deviceUid, username, password })
            })
            if (res.ok) {
                msg.textContent = 'Đăng ký thành công, mời đăng nhập'
                msg.className = 'ok'
                setRegisterMode(false)
                document.getElementById('loginUsername').value = username
            } else {
                const body = await res.json().catch(() => ({}))
                msg.textContent = body.error || 'Đăng ký thất bại'
                msg.className = 'error'
            }
        } catch (err) {
            msg.textContent = 'Lỗi kết nối server'
            msg.className = 'error'
        }
        return
    }

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
            msg.textContent = body.error || 'Đăng nhập thất bại'
            msg.className = 'error'
            return
        }
        session = { username, password, role: body.role, deviceUid: body.deviceUid || null }
        localStorage.setItem('wqSession', JSON.stringify(session))
        window.location.href = roleHomePage(session.role)
    } catch (err) {
        msg.textContent = 'Lỗi kết nối server'
        msg.className = 'error'
    }
})

// If a session is already stored, re-validate it against the server and jump
// straight to the right dashboard — never trust the stored copy on its own.
;(async function init() {
    if (!session || !session.username || !session.password) return
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: session.username, password: session.password })
        })
        if (!res.ok) {
            localStorage.removeItem('wqSession')
            return
        }
        const body = await res.json()
        session.role = body.role
        session.deviceUid = body.deviceUid || null
        localStorage.setItem('wqSession', JSON.stringify(session))
        window.location.href = roleHomePage(session.role)
    } catch (err) {
        // stay on login screen if the server is unreachable
    }
})()
