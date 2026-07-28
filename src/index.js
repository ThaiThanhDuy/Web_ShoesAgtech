require('dotenv').config()

const path = require('path')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')

const waterQualityRoutes = require('./routes/waterQuality')
const deviceRoutes = require('./routes/devices')
const authRoutes = require('./routes/auth')
const profileRoutes = require('./routes/profile')
const robotRoutes = require('./routes/robot')
const feedingRoutes = require('./routes/feeding')

const app = express()
app.set('trust proxy', 1)
// helmet's default script-src/img-src only allow 'self', which silently blocks
// the CDN-hosted libraries the dashboard needs (Leaflet, Chart.js, xlsx) and
// the Leaflet map tile images — leaving public/user.html & admin.html blank.
// Explicitly allow exactly the external origins those pages load from.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.jsdelivr.net"],
            styleSrc: ["'self'", "https:", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https://server.arcgisonline.com", "https://*.basemaps.cartocdn.com"],
            fontSrc: ["'self'", "https:", "data:"],
            connectSrc: ["'self'"]
        }
    }
}))
app.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
}))
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
app.use('/api/feeding', feedingRoutes)
app.use(express.static(path.join(__dirname, '..', 'public')))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`Shoes Agtech server listening on port ${PORT}`)
})
