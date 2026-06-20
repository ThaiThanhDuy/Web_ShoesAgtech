require('dotenv').config()

const path = require('path')
const express = require('express')
const cors = require('cors')

const waterQualityRoutes = require('./routes/waterQuality')
const deviceRoutes = require('./routes/devices')
const authRoutes = require('./routes/auth')
const profileRoutes = require('./routes/profile')
const robotRoutes = require('./routes/robot')

const app = express()
app.use(cors())
app.use(express.json())

// Lightweight, no-auth endpoint — the web dashboard polls this to show the
// connection status dot in the header (green = reachable, red = not).
app.get('/api/health', (req, res) => res.json({ ok: true }))

app.use('/api/water-quality', waterQualityRoutes)
app.use('/api/devices', deviceRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/profile', profileRoutes)
app.use('/api/robot', robotRoutes)
app.use(express.static(path.join(__dirname, '..', 'public')))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`Water quality server listening on port ${PORT}`)
})
