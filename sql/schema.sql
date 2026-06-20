CREATE DATABASE IF NOT EXISTS shoes_agtech
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE shoes_agtech;

-- Generic sensor/sample data table — named DATA (not water_quality_records)
-- since boards may send other kinds of readings in the future, not just water quality.
--
-- ph_am/ph_pm: split by local wall-clock hour at capture (00h-12h / 12h-24h) —
-- only one of the two is set per row, mirroring the firmware's own sáng/chiều
-- slot split (AP_ShoesAgtech.cpp, _ph_update_daily_slots).
-- alk_tgt: firmware's alkMgl as-is, always sent — "real-time" estimate whatever
-- its current quality (single-point heuristic when today's slots aren't full).
-- alk_mgl: only set when the firmware reported slotStatus=FULL (today's
-- sáng+chiều pH both available, so alkMgl came from the ΔpH titration formula
-- — see AP_SHOESAGTECH_REFERENCE.md §"Logic phân slot kiềm ΔpH") — the more
-- accurate value; NULL otherwise rather than a guessed number.
-- `ph` kept (nullable) for historical rows captured before this split existed.
CREATE TABLE IF NOT EXISTS DATA (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    device_id   VARCHAR(64)  NOT NULL DEFAULT 'unknown',
    wp_idx      INT          NOT NULL,
    lat         DOUBLE       NOT NULL,
    lon         DOUBLE       NOT NULL,
    alt         DOUBLE       NULL,
    ph          DOUBLE       NULL,
    ph_am       DOUBLE       NULL,
    ph_pm       DOUBLE       NULL,
    temp        DOUBLE       NULL,
    alk_tgt     DOUBLE       NULL,
    alk_mgl     DOUBLE       NULL,
    captured_at DATETIME     NOT NULL,
    synced_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_captured_at (captured_at),
    INDEX idx_device_id   (device_id)
);

-- One row per physical Cube/Pixhawk board, identified by its hardware UID
-- (QGC's Vehicle.vehicleUIDStr, read from MAVLink AUTOPILOT_VERSION). A board
-- must be registered here (see scripts/registerDevice.js) before it can sync data.
CREATE TABLE IF NOT EXISTS devices (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    device_uid    VARCHAR(64)  NOT NULL UNIQUE,
    username      VARCHAR(64)  NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Web dashboard admin accounts (manage all boards, edit/delete data). admin_key is
-- this admin's personal key for POST /api/devices/register (x-admin-key header).
-- Create one via `npm run create-admin -- <username> <password>` — not from .env.
CREATE TABLE IF NOT EXISTS admins (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    username      VARCHAR(64)  NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    admin_key     VARCHAR(128) NOT NULL UNIQUE,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Contact/profile info for a board, shown on the "Thông tin" page. Editable
-- only by that board's own account; admin can view it (read-only) per board.
CREATE TABLE IF NOT EXISTS device_profiles (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    device_uid VARCHAR(64) NOT NULL UNIQUE,
    ho         VARCHAR(100),
    ten        VARCHAR(100),
    phone      VARCHAR(20),
    address    VARCHAR(255),
    supplier   VARCHAR(255),
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (device_uid) REFERENCES devices(device_uid) ON DELETE CASCADE
);

-- Robot telemetry (battery/GPS/flight mode/position) — captured by QGC on a
-- timer regardless of water-quality waypoints, auto-synced in the background.
-- Never shown in the "Chất lượng nước" dialog; powers the "Robot" page instead.
-- gps_fix follows MAVLink GPS_FIX_TYPE (0=no GPS, 2=2D, 3=3D, 4/5=DGPS/RTK...).
CREATE TABLE IF NOT EXISTS robot_telemetry (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    device_id    VARCHAR(64) NOT NULL DEFAULT 'unknown',
    battery_pct  DOUBLE      NULL,
    gps_fix      INT         NULL,
    gps_sats     INT         NULL,
    flight_mode  VARCHAR(32) NULL,
    speed_mps    DOUBLE      NULL,
    throttle_pct DOUBLE      NULL,
    lat          DOUBLE      NULL,
    lon          DOUBLE      NULL,
    captured_at  DATETIME    NOT NULL,
    synced_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_captured_at (captured_at),
    INDEX idx_device_id   (device_id)
);
