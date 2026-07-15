let session = JSON.parse(localStorage.getItem('wqSession') || 'null')

// Set by initSession() when an admin opens user.html via the "Chi tiết" button
// in admin.html (?asDevice=<uid>) — admin's own credentials still go out on
// every request (authHeaders() below), but every API call gets scoped to this
// device_uid instead of the caller's own, via apiUrl(). Not persisted: it only
// applies to this page load, never bleeds into a normal device-account session.
let viewingAsDeviceUid = null

function authHeaders(extra) {
    return Object.assign({
        'Content-Type': 'application/json',
        'x-username': session.username,
        'x-password': session.password
    }, extra || {})
}

// Appends ?deviceId=/?deviceUid= for the board being impersonated — a no-op
// for a normal device-account session (viewingAsDeviceUid stays null), since
// the backend already scopes those requests to the caller's own device_uid.
function apiUrl(path) {
    if (!viewingAsDeviceUid) return path
    const key = path.startsWith('/api/profile') ? 'deviceUid' : 'deviceId'
    const sep = path.includes('?') ? '&' : '?'
    return `${path}${sep}${key}=${encodeURIComponent(viewingAsDeviceUid)}`
}

function saveSession() {
    localStorage.setItem('wqSession', JSON.stringify(session))
}

function logout() {
    session = null
    localStorage.removeItem('wqSession')
    window.location.href = 'index.html'
}

// Re-validates the stored session against the server every time an admin/user
// page loads. If the role doesn't match this page, redirect to the right one.
// If the session is invalid (wrong/changed password, deleted account), bounce
// to the login screen — a stale localStorage entry must never grant access.
async function initSession(expectedRole, onReady) {
    if (!session || !session.username || !session.password) {
        window.location.href = 'index.html'
        return
    }
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: session.username, password: session.password })
        })
        if (!res.ok) {
            localStorage.removeItem('wqSession')
            window.location.href = 'index.html'
            return
        }
        const body = await res.json()
        session.role = body.role
        session.deviceUid = body.deviceUid || null
        saveSession()

        const impersonateUid = new URLSearchParams(window.location.search).get('asDevice')
        if (expectedRole === 'device' && session.role === 'admin' && impersonateUid) {
            viewingAsDeviceUid = impersonateUid
            _setupImpersonationUi(impersonateUid)
        } else if (session.role !== expectedRole) {
            window.location.href = session.role === 'admin' ? 'admin.html' : 'user.html'
            return
        }
        onReady()
    } catch (err) {
        window.location.href = 'index.html'
    }
}

// Admin viewing a board's user.html via "Chi tiết" — flag it clearly (so it's
// never mistaken for the admin's own account) and hide "Đổi mật khẩu", which
// would otherwise silently change the ADMIN's own login password instead of
// the board's (it always acts on the credentials in authHeaders()).
function _setupImpersonationUi(deviceUid) {
    const changePwSection = document.getElementById('changePwSection')
    if (changePwSection) changePwSection.classList.add('hidden')

    const welcome = document.getElementById('welcomeMsg')
    if (welcome) welcome.textContent = `Đang xem: ${deviceUid} (admin)`

    const headerLeft = document.querySelector('.header-left')
    if (headerLeft) {
        const backBtn = document.createElement('button')
        backBtn.className = 'small-btn'
        backBtn.textContent = '← Quay lại quản trị'
        backBtn.addEventListener('click', () => { window.location.href = 'admin.html' })
        headerLeft.appendChild(backBtn)
    }
}

function closeUserMenu() {
    document.getElementById('userMenuDropdown').classList.add('hidden')
}

function openDrawer() {
    closeUserMenu()
    document.getElementById('sideDrawer').classList.add('open')
    document.getElementById('drawerOverlay').classList.remove('hidden')
}

function closeDrawer() {
    document.getElementById('sideDrawer').classList.remove('open')
    document.getElementById('drawerOverlay').classList.add('hidden')
}

document.getElementById('drawerToggleBtn').addEventListener('click', () => {
    document.getElementById('sideDrawer').classList.contains('open') ? closeDrawer() : openDrawer()
})
document.getElementById('drawerOverlay').addEventListener('click', closeDrawer)

document.getElementById('welcomeMsg').textContent =
    session ? (session.role === 'admin' ? `${session.username} (admin)` : session.username) : ''

document.getElementById('userMenuBtn').addEventListener('click', (e) => {
    e.stopPropagation()
    closeDrawer()
    document.getElementById('userMenuDropdown').classList.toggle('hidden')
})
document.addEventListener('click', () => {
    document.getElementById('userMenuDropdown').classList.add('hidden')
})

const infoMenuItem = document.getElementById('infoMenuItem')
if (infoMenuItem) {
    infoMenuItem.addEventListener('click', (e) => {
        e.preventDefault()
        if (typeof setViewMode === 'function') {
            setViewMode(session && session.role === 'admin' ? 'adminProfile' : 'info')
        }
    })
}

document.getElementById('logoutMenuItem').addEventListener('click', (e) => {
    e.preventDefault()
    logout()
})

document.getElementById('changePasswordSubmitBtn').addEventListener('click', async () => {
    const currentPassword = document.getElementById('currentPasswordCheck').value
    const newPassword = document.getElementById('newPassword').value
    const newPasswordConfirm = document.getElementById('newPasswordConfirm').value
    const msg = document.getElementById('changePasswordMsg')

    if (currentPassword !== session.password) {
        msg.textContent = 'Mật khẩu hiện tại không đúng'
        msg.className = 'error'
        return
    }
    if (!newPassword || newPassword.length < 4) {
        msg.textContent = 'Mật khẩu mới phải có ít nhất 4 ký tự'
        msg.className = 'error'
        return
    }
    if (newPassword !== newPasswordConfirm) {
        msg.textContent = 'Hai mật khẩu mới không khớp'
        msg.className = 'error'
        return
    }

    try {
        const res = await fetch('/api/auth/password', {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({ newPassword })
        })
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            msg.textContent = body.error || 'Đổi mật khẩu thất bại'
            msg.className = 'error'
            return
        }
        session.password = newPassword
        saveSession()
        document.getElementById('currentPasswordCheck').value = ''
        document.getElementById('newPassword').value = ''
        document.getElementById('newPasswordConfirm').value = ''
        msg.textContent = 'Đổi mật khẩu thành công'
        msg.className = 'ok'
    } catch (err) {
        msg.textContent = 'Lỗi kết nối server'
        msg.className = 'error'
    }
})

// Header status dot — green: online and up to date. Red: no network or
// server unreachable (always wins, shown regardless of new-data state).
// Yellow: online but newer data exists on the server than what's loaded
// (page-specific code calls setNewDataAvailable() to raise/clear this).
let _connIsOnline = true
let _connHasNewData = false

function _renderConnectionDot() {
    const dot = document.getElementById('connStatusDot')
    if (!dot) return
    dot.classList.remove('offline', 'new-data')
    if (!_connIsOnline) {
        dot.classList.add('offline')
    } else if (_connHasNewData) {
        dot.classList.add('new-data')
    }
}

function setConnectionStatus(online) {
    _connIsOnline = online
    _renderConnectionDot()
}

function setNewDataAvailable(flag) {
    _connHasNewData = flag
    _renderConnectionDot()
}

async function checkServerHealth() {
    if (!navigator.onLine) {
        setConnectionStatus(false)
        return
    }
    try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        setConnectionStatus(res.ok)
    } catch (err) {
        setConnectionStatus(false)
    }
}

window.addEventListener('online', checkServerHealth)
window.addEventListener('offline', () => setConnectionStatus(false))
checkServerHealth()
setInterval(checkServerHealth, 15000)

// Light/Dark/Auto theme — persisted in localStorage (per browser, not per
// account, see the "themeSelect" <select> in user.html's "Thông tin" page /
// admin.html's account dropdown). Applied immediately via [data-theme="dark"]
// CSS overrides (see style.css's :root). The actual <html data-theme>
// attribute is already set as early as possible by an inline script in
// <head>, before this file loads, to avoid a flash of the wrong theme — this
// just keeps the <select> in sync with whatever that inline script applied.
function _systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

function _applyTheme(theme) {
    const dark = theme === 'dark' || (theme === 'auto' && _systemPrefersDark())
    if (dark) document.documentElement.setAttribute('data-theme', 'dark')
    else document.documentElement.removeAttribute('data-theme')
}

function setTheme(theme) {
    _applyTheme(theme)
    try { localStorage.setItem('wqTheme', theme) } catch (e) { /* private mode etc. */ }
}

function _storedTheme() {
    try { return localStorage.getItem('wqTheme') || 'light' } catch (e) { return 'light' }
}

const themeSelect = document.getElementById('themeSelect')
if (themeSelect) {
    themeSelect.value = _storedTheme()
    themeSelect.addEventListener('change', () => setTheme(themeSelect.value))
}

// Re-applies live if the OS/browser theme flips while "auto" is selected —
// otherwise it'd only pick up the new system theme on next page load.
if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (_storedTheme() === 'auto') _applyTheme('auto')
    })
}
