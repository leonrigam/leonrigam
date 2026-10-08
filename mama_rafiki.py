import sqlite3
import json
import os
import sys
import threading
import webbrowser
from datetime import datetime, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

DB_FILE = "mama_rafiki.db"
PORT = 3000

# ==========================================
# 1. DATABASE SETUP & SCHEMA
# ==========================================

def init_db():
    """Initializes SQLite database with all 5 normalized tables and indexes."""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("PRAGMA foreign_keys = ON;")

    # 1. Mothers
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS mothers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            phone TEXT NOT NULL UNIQUE,
            clinic_location TEXT NOT NULL,
            trimester TEXT CHECK(trimester IN ('trimester_1', 'trimester_2', 'trimester_3', 'postnatal')),
            visual_symbol TEXT NOT NULL,
            mpesa_balance REAL DEFAULT 0.0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    ''')

    # 2. Children
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS children (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mother_id INTEGER NOT NULL,
            child_name TEXT NOT NULL,
            date_of_birth DATE NOT NULL,
            gender TEXT,
            FOREIGN KEY (mother_id) REFERENCES mothers(id) ON DELETE CASCADE
        );
    ''')

    # 3. Clinic Visits
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS clinic_visits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mother_id INTEGER NOT NULL,
            anc_stage TEXT NOT NULL,
            scheduled_date DATE NOT NULL,
            status TEXT DEFAULT 'upcoming' CHECK(status IN ('upcoming', 'due_soon', 'completed', 'rescheduled', 'missed')),
            services_json TEXT,
            systolic_bp INTEGER,
            diastolic_bp INTEGER,
            FOREIGN KEY (mother_id) REFERENCES mothers(id) ON DELETE CASCADE
        );
    ''')

    # 4. Vaccinations
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS vaccinations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            child_id INTEGER NOT NULL,
            vaccine_name TEXT NOT NULL,
            due_date DATE NOT NULL,
            age_milestone TEXT NOT NULL,
            status TEXT DEFAULT 'upcoming' CHECK(status IN ('upcoming', 'due_soon', 'completed', 'missed')),
            FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE
        );
    ''')

    # 5. Reminders
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mother_id INTEGER NOT NULL,
            reminder_type TEXT CHECK(reminder_type IN ('SMS', 'WhatsApp', 'Voice_Note', 'Emergency_Alert')),
            message_text TEXT NOT NULL,
            voice_script_swahili TEXT,
            sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (mother_id) REFERENCES mothers(id) ON DELETE CASCADE
        );
    ''')

    # Indexes
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_visits_mother ON clinic_visits(mother_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_vaccines_child ON vaccinations(child_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_symbol ON mothers(visual_symbol);")

    # Seed demo data if empty
    cursor.execute("SELECT COUNT(*) FROM mothers;")
    if cursor.fetchone()[0] == 0:
        cursor.execute('''
            INSERT INTO mothers (full_name, phone, clinic_location, trimester, visual_symbol, mpesa_balance)
            VALUES ('Amina Zawadi', '+254712345678', 'Kibera South Clinic', 'trimester_2', 'Alizeti', 0.0)
        ''')
        m_id = cursor.lastrowid

        cursor.execute('''
            INSERT INTO children (mother_id, child_name, date_of_birth, gender)
            VALUES (?, 'Baraka Zawadi', '2026-01-15', 'Male')
        ''', (m_id,))
        c_id = cursor.lastrowid

        due_date = (datetime.now() + timedelta(days=2)).strftime('%Y-%m-%d')
        cursor.execute('''
            INSERT INTO clinic_visits (mother_id, anc_stage, scheduled_date, status)
            VALUES (?, 'ANC 2 Visit', ?, 'upcoming')
        ''', (m_id, due_date))

        cursor.execute('''
            INSERT INTO vaccinations (child_id, vaccine_name, due_date, age_milestone)
            VALUES (?, 'Pentavalent 1', '2026-11-10', '6 Weeks')
        ''', (c_id,))

    conn.commit()
    conn.close()

# ==========================================
# 2. CORE BUSINESS LOGIC ENGINES
# ==========================================

def run_voice_passkey(symbol):
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("SELECT id, full_name, mpesa_balance FROM mothers WHERE LOWER(visual_symbol) = LOWER(?)", (symbol,))
    mother = cursor.fetchone()
    if not mother:
        conn.close()
        return {"status": "error", "message": f"Alama ya '{symbol}' haijapatikana."}
    
    m_id, name, balance = mother
    cursor.execute("SELECT anc_stage, scheduled_date FROM clinic_visits WHERE mother_id = ? AND status IN ('upcoming', 'due_soon') ORDER BY scheduled_date ASC LIMIT 1", (m_id,))
    v = cursor.fetchone()
    v_text = f"miadi yako ya {v[0]} ni tarehe {v[1]}" if v else "huna miadi ya karibu"

    cursor.execute("SELECT v.vaccine_name, v.due_date, c.child_name FROM vaccinations v JOIN children c ON v.child_id = c.id WHERE c.mother_id = ? AND v.status IN ('upcoming', 'due_soon') ORDER BY v.due_date ASC LIMIT 1", (m_id,))
    vac = cursor.fetchone()
    vac_text = f"chanjo ya {vac[2]} ya {vac[0]} ni tarehe {vac[1]}" if vac else "huna chanjo iliyobaki"
    conn.close()

    script = f"Jambo {name}! Alama yako ni {symbol.upper()}. Kumbuka: {v_text}. Pia, {vac_text}. Salio lako la M-Pesa ni Shilingi {int(balance)}."
    return {"status": "success", "mother_name": name, "symbol": symbol, "script": script, "balance": balance}

def run_danger_triage(mother_id, danger_sign):
    triage_map = {
        "Kichwa Kuuma Kali": "Kichwa kuuma sana kinaweza kuwa ishara ya presha ya juu. Lalia upande wa kushoto na uende kliniki haraka.",
        "Macho Kutoona Vizuri": "Macho kutoona vizuri ni hatari ya Pre-eclampsia. Pata usafiri wa dharura kwenda hospitali.",
        "Kuvimba Uso na Mikono": "Kuvimba uso au mikono kwa ghafla kunahitaji vipimo vya presha na mkojo mara moja.",
        "Kutoka Damu": "HATARI KUBWA: Kutoka damu wakati wa ujauzito ni dharura. Nenda kituo cha afya kilicho karibu sasa hivi!"
    }
    guidance = triage_map.get(danger_sign, "Tafadhali muone daktari mara moja.")
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("INSERT INTO reminders (mother_id, reminder_type, message_text, voice_script_swahili) VALUES (?, 'Emergency_Alert', ?, ?)",
                   (mother_id, f"DHARURA: {danger_sign}", guidance))
    conn.commit()
    conn.close()
    return {"status": "success", "sign": danger_sign, "guidance": guidance}

def run_high_bp_simulation():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("SELECT id, mother_id FROM clinic_visits WHERE status IN ('upcoming', 'due_soon') LIMIT 1")
    v = cursor.fetchone()
    if not v:
        conn.close()
        return {"status": "error", "message": "No active clinic visits available to simulate."}
    
    v_id, m_id = v
    systolic, diastolic = 145, 95
    services = json.dumps(["BP Check", "Pre-Eclampsia Screening", "Ultrasound"])
    
    cursor.execute("UPDATE clinic_visits SET status = 'completed', systolic_bp = ?, diastolic_bp = ?, services_json = ? WHERE id = ?",
                   (systolic, diastolic, services, v_id))
    cursor.execute("UPDATE mothers SET mpesa_balance = mpesa_balance + 50 WHERE id = ?", (m_id,))
    cursor.execute("SELECT full_name, phone, clinic_location, mpesa_balance FROM mothers WHERE id = ?", (m_id,))
    m = cursor.fetchone()
    
    alert_msg = f"RED-ALERT: Dangerous High BP ({systolic}/{diastolic} mmHg) logged for {m[0]} ({m[1]}) at {m[2]}!"
    cursor.execute("INSERT INTO reminders (mother_id, reminder_type, message_text) VALUES (?, 'Emergency_Alert', ?)", (m_id, alert_msg))
    conn.commit()
    conn.close()
    return {"status": "success", "systolic": systolic, "diastolic": diastolic, "mother": m[0], "clinic": m[2], "new_balance": m[3], "alert": alert_msg}

def run_cron_job():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    target_date = (datetime.now() + timedelta(days=2)).strftime('%Y-%m-%d')
    cursor.execute('''
        SELECT v.id, m.id, m.full_name, m.phone, m.visual_symbol, m.clinic_location, v.anc_stage
        FROM clinic_visits v JOIN mothers m ON v.mother_id = m.id WHERE v.scheduled_date = ? AND v.status = 'upcoming'
    ''', (target_date,))
    visits = cursor.fetchall()
    processed = []
    for vis in visits:
        v_id, m_id, name, phone, symbol, clinic, stage = vis
        txt = f"Habari {name}! Miadi ya {stage} ni tarehe {target_date} katika kliniki ya {clinic}. Alama: {symbol}."
        voice = f"Jambo {name}. Mama-Rafiki inakukumbusha miadi ya {stage} tarehe {target_date} huko {clinic}."
        cursor.execute("INSERT INTO reminders (mother_id, reminder_type, message_text, voice_script_swahili) VALUES (?, 'Voice_Note', ?, ?)", (m_id, txt, voice))
        cursor.execute("UPDATE clinic_visits SET status = 'due_soon' WHERE id = ?", (v_id,))
        processed.append({"mother": name, "phone": phone, "sms": txt, "voice": voice})
    conn.commit()
    conn.close()
    return {"status": "success", "count": len(processed), "items": processed}

def run_ussd(phone, option=None):
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("SELECT id, full_name, visual_symbol, mpesa_balance FROM mothers WHERE phone = ?", (phone,))
    m = cursor.fetchone()
    if not m:
        conn.close()
        return "Nambari hii haijasajiliwa. Tembelea kliniki iliyo karibu."
    m_id, name, symbol, balance = m

    if option is None:
        conn.close()
        return f"USSD (*123#)\nKaribu {name} (Alama: {symbol})\n1. Thibitisha Fika\n2. Omba Kubadilisha Siku (+7)\n3. Angalia Chanjo ya Mtoto\n4. Salio la Zawadi"
    
    opt = int(option)
    if opt == 1:
        cursor.execute("UPDATE clinic_visits SET status = 'completed' WHERE mother_id = ? AND status IN ('upcoming', 'due_soon')", (m_id,))
        conn.commit()
        conn.close()
        return f"Ahsante {name}! Umethibitisha fika yako kliniki."
    elif opt == 2:
        cursor.execute("SELECT id, scheduled_date FROM clinic_visits WHERE mother_id = ? AND status IN ('upcoming', 'due_soon') ORDER BY scheduled_date ASC LIMIT 1", (m_id,))
        v = cursor.fetchone()
        if v:
            new_date = (datetime.strptime(v[1], '%Y-%m-%d') + timedelta(days=7)).strftime('%Y-%m-%d')
            cursor.execute("UPDATE clinic_visits SET scheduled_date = ?, status = 'rescheduled' WHERE id = ?", (new_date, v[0]))
            conn.commit()
            conn.close()
            return f"Miadi yako imesogezwa mbele mpaka {new_date}."
        conn.close()
        return "Huna miadi inayoweza kubadilishwa."
    elif opt == 3:
        cursor.execute("SELECT v.vaccine_name, v.due_date, c.child_name FROM vaccinations v JOIN children c ON v.child_id = c.id WHERE c.mother_id = ? ORDER BY v.due_date ASC LIMIT 1", (m_id,))
        vac = cursor.fetchone()
        conn.close()
        return f"Chanjo ya {vac[2]} ya {vac[0]} ni tarehe {vac[1]}." if vac else "Huna chanjo iliyosajiliwa."
    elif opt == 4:
        conn.close()
        return f"Salio lako la M-Pesa Zawadi ni KSh {int(balance)}."

# ==========================================
# 3. EMBEDDED WEB SERVER & VISUAL UI
# ==========================================

HTML_INTERFACE = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Mama-Rafiki | Care Tracking Workbench</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f4f7f6; margin: 0; padding: 20px; color: #333; }
        .header { background: #2c3e50; color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
        .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
        .tab-btn { padding: 12px 20px; background: #e0e0e0; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; }
        .tab-btn.active { background: #27ae60; color: white; }
        .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
        .btn { padding: 10px 15px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; text-align: center; }
        .btn-primary { background: #3498db; color: white; }
        .btn-danger { background: #e74c3c; color: white; }
        .btn-success { background: #2ecc71; color: white; }
        .btn-warning { background: #f39c12; color: white; }
        pre { background: #272727; color: #7ec699; padding: 15px; border-radius: 6px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
        th { background: #f2f2f2; }
    </style>
</head>
<body>

<div class="header">
    <div>
        <h1 style="margin:0;">🌻 Mama-Rafiki Health Workbench</h1>
        <small>Automated Offline Maternal & Child Health System</small>
    </div>
    <a href="/download_db" class="btn btn-warning" style="text-decoration:none;">💾 Download mama_rafiki.db File</a>
</div>

<div class="tabs">
    <button class="tab-btn active" onclick="showTab('tab-voice')">🎙️ Sauti ya Mama (Voice Companion)</button>
    <button class="tab-btn" onclick="showTab('tab-workbench')">🏥 Clinic Workbench & High BP</button>
    <button class="tab-btn" onclick="showTab('tab-ussd')">📱 USSD Simulator (*123#)</button>
    <button class="tab-btn" onclick="showTab('tab-sqlite')">🗄️ Built-In Visual SQLite Browser</button>
</div>

<!-- TAB 1: SAUTI YA MAMA -->
<div id="tab-voice" class="card">
    <h2>Zero-Literacy Visual Symbol Passkey</h2>
    <p>Tap a mother's culturally recognizable clinic symbol to hear her spoken Swahili status:</p>
    <div class="grid">
        <button class="btn btn-primary" onclick="triggerPasskey('Alizeti')">🌻 Alizeti (Sunflower)</button>
        <button class="btn btn-primary" onclick="triggerPasskey('Mbuyu')">🌳 Mbuyu (Baobab)</button>
        <button class="btn btn-primary" onclick="triggerPasskey('Kibuyu')">🫙 Kibuyu (Calabash)</button>
        <button class="btn btn-primary" onclick="triggerPasskey('Mgunga')">🌿 Mgunga (Acacia)</button>
        <button class="btn btn-primary" onclick="triggerPasskey('Nyota')">⭐ Nyota (Star)</button>
        <button class="btn btn-primary" onclick="triggerPasskey('Simba')">🦁 Simba (Lioness)</button>
    </div>

    <h2 style="margin-top:30px;">Audio-Guided Danger Sign Triage</h2>
    <div class="grid">
        <button class="btn btn-danger" onclick="triggerTriage('Kichwa Kuuma Kali')">🤕 Severe Headache</button>
        <button class="btn btn-danger" onclick="triggerTriage('Macho Kutoona Vizuri')">👁️ Blurred Vision</button>
        <button class="btn btn-danger" onclick="triggerTriage('Kuvimba Uso na Mikono')">🦶 Body Swelling</button>
        <button class="btn btn-danger" onclick="triggerTriage('Kutoka Damu')">🩸 Bleeding Danger</button>
    </div>

    <h3>Spoken Swahili Voice Output:</h3>
    <pre id="voice-output">Click any passkey symbol or danger touch card above...</pre>
</div>

<!-- TAB 2: CLINIC WORKBENCH -->
<div id="tab-workbench" class="card" style="display:none;">
    <h2>Clinic Workbench & ANC Escalation</h2>
    <div style="display:flex; gap:15px;">
        <button class="btn btn-danger" onclick="simulateHighBP()">🚨 1-Click Simulate High BP (145/95 Test)</button>
        <button class="btn btn-success" onclick="runCron()">⏰ Run 48-Hour Reminder Cron</button>
    </div>
    <h3>System Event Log:</h3>
    <pre id="workbench-output">Click buttons above to execute actions...</pre>
</div>

<!-- TAB 3: USSD SIMULATOR -->
<div id="tab-ussd" class="card" style="display:none;">
    <h2>Interactive 2G Feature Phone Simulator (*123#)</h2>
    <p>Phone Number: <strong>+254712345678</strong> (Amina Zawadi)</p>
    <div style="display:flex; gap:10px; margin-bottom:15px;">
        <button class="btn btn-primary" onclick="callUSSD(null)">📞 Dial *123#</button>
        <button class="btn btn-success" onclick="callUSSD(1)">1. Thibitisha Fika</button>
        <button class="btn btn-warning" onclick="callUSSD(2)">2. Reschedule (+7 Days)</button>
        <button class="btn btn-primary" onclick="callUSSD(3)">3. Child Vaccine Schedule</button>
        <button class="btn btn-success" onclick="callUSSD(4)">4. M-Pesa Balance</button>
    </div>
    <div style="background:#1e272e; color:#00d2d3; padding:20px; font-family:monospace; border-radius:8px; font-size:16px;">
        <pre id="ussd-screen" style="background:none; color:inherit; margin:0;">Dial *123# to initiate USSD menu...</pre>
    </div>
</div>

<!-- TAB 4: VISUAL SQLITE BROWSER -->
<div id="tab-sqlite" class="card" style="display:none;">
    <h2>Built-In Visual SQLite Browser</h2>
    <label>Select Table: </label>
    <select id="table-select" onchange="loadTableData()" style="padding:8px; border-radius:4px;">
        <option value="mothers">mothers</option>
        <option value="children">children</option>
        <option value="clinic_visits">clinic_visits</option>
        <option value="vaccinations">vaccinations</option>
        <option value="reminders">reminders</option>
    </select>
    
    <div id="table-container" style="margin-top:15px; overflow-x:auto;">Loading table data...</div>

    <h3 style="margin-top:25px;">Run Custom SQL Query:</h3>
    <div style="display:flex; gap:10px;">
        <input type="text" id="sql-input" value="SELECT * FROM mothers;" style="flex:1; padding:10px; font-family:monospace;">
        <button class="btn btn-primary" onclick="runSQL()">Execute SQL</button>
    </div>
    <pre id="sql-output" style="margin-top:10px;">SQL results will render here...</pre>
</div>

<script>
    function showTab(tabId) {
        document.querySelectorAll('.card').forEach(c => c.style.display = 'none');
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.getElementById(tabId).style.display = 'block';
        event.target.classList.add('active');
        if(tabId === 'tab-sqlite') loadTableData();
    }

    function triggerPasskey(symbol) {
        fetch('/api/passkey?symbol=' + symbol)
            .then(res => res.json())
            .then(data => {
                document.getElementById('voice-output').innerText = "🔊 Spoken Audio Script:\\n" + JSON.stringify(data.script, null, 2);
                if('speechSynthesis' in window) {
                    let msg = new SpeechSynthesisUtterance(data.script);
                    msg.lang = 'sw-KE';
                    window.speechSynthesis.speak(msg);
                }
            });
    }

    function triggerTriage(sign) {
        fetch('/api/triage?sign=' + encodeURIComponent(sign))
            .then(res => res.json())
            .then(data => {
                document.getElementById('voice-output').innerText = "🚨 DANGER TRIAGE ALERT:\\nSign: " + data.sign + "\\nGuidance: " + data.guidance;
            });
    }

    function simulateHighBP() {
        fetch('/api/simulate_bp')
            .then(res => res.json())
            .then(data => {
                document.getElementById('workbench-output').innerText = JSON.stringify(data, null, 2);
            });
    }

    function runCron() {
        fetch('/api/cron')
            .then(res => res.json())
            .then(data => {
                document.getElementById('workbench-output').innerText = JSON.stringify(data, null, 2);
            });
    }

    function callUSSD(opt) {
        let url = '/api/ussd?phone=%2B254712345678' + (opt ? '&option=' + opt : '');
        fetch(url)
            .then(res => res.text())
            .then(text => {
                document.getElementById('ussd-screen').innerText = text;
            });
    }

    function loadTableData() {
        let table = document.getElementById('table-select').value;
        fetch('/api/table_data?table=' + table)
            .then(res => res.json())
            .then(data => {
                if(!data.rows || data.rows.length === 0) {
                    document.getElementById('table-container').innerHTML = "<p>No records in table.</p>";
                    return;
                }
                let html = "<table><thead><tr>";
                data.columns.forEach(col => html += "<th>" + col + "</th>");
                html += "</tr></thead><tbody>";
                data.rows.forEach(row => {
                    html += "<tr>";
                    row.forEach(val => html += "<td>" + (val !== null ? val : '') + "</td>");
                    html += "</tr>";
                });
                html += "</tbody></table>";
                document.getElementById('table-container').innerHTML = html;
            });
    }

    function runSQL() {
        let sql = document.getElementById('sql-input').value;
        fetch('/api/query?sql=' + encodeURIComponent(sql))
            .then(res => res.json())
            .then(data => {
                document.getElementById('sql-output').innerText = JSON.stringify(data, null, 2);
            });
    }
</script>

</body>
</html>
"""

class RequestHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(HTML_INTERFACE.encode('utf-8'))

        elif path == "/download_db":
            if os.path.exists(DB_FILE):
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Disposition", f"attachment; filename={DB_FILE}")
                self.end_headers()
                with open(DB_FILE, "rb") as f:
                    self.wfile.write(f.read())

        elif path == "/api/passkey":
            symbol = params.get("symbol", ["Alizeti"])[0]
            res = run_voice_passkey(symbol)
            self._send_json(res)

        elif path == "/api/triage":
            sign = params.get("sign", ["Kichwa Kuuma Kali"])[0]
            res = run_danger_triage(1, sign)
            self._send_json(res)

        elif path == "/api/simulate_bp":
            res = run_high_bp_simulation()
            self._send_json(res)

        elif path == "/api/cron":
            res = run_cron_job()
            self._send_json(res)

        elif path == "/api/ussd":
            phone = params.get("phone", ["+254712345678"])[0]
            opt = params.get("option", [None])[0]
            res = run_ussd(phone, opt)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(res.encode('utf-8'))

        elif path == "/api/table_data":
            table = params.get("table", ["mothers"])[0]
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute(f"PRAGMA table_info({table});")
            cols = [c[1] for c in cursor.fetchall()]
            cursor.execute(f"SELECT * FROM {table};")
            rows = cursor.fetchall()
            conn.close()
            self._send_json({"columns": cols, "rows": rows})

        elif path == "/api/query":
            sql = params.get("sql", ["SELECT * FROM mothers;"])[0]
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            try:
                cursor.execute(sql)
                rows = cursor.fetchall()
                cols = [d[0] for d in cursor.description] if cursor.description else []
                res = {"status": "success", "columns": cols, "rows": rows}
            except Exception as e:
                res = {"status": "error", "message": str(e)}
            conn.close()
            self._send_json(res)

    def _send_json(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

def start_server():
    server = HTTPServer(('localhost', PORT), RequestHandler)
    print(f"\n==================================================")
    print(f"🚀 MAMA-RAFIKI WEB WORKBENCH IS RUNNING ONLINE!")
    print(f"🌐 Open Browser at: http://localhost:{PORT}")
    print(f"==================================================\n")
    server.serve_forever()

if __name__ == "__main__":
    init_db()
    # Auto-open browser on startup
    threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
    start_server()