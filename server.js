
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// --------------------------------------------------
// App Configuration
// --------------------------------------------------

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database(
    path.join(__dirname, 'data', 'corvo.sqlite')
);

db.pragma('journal_mode = WAL');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
    dest: path.join(__dirname, 'uploads')
});

// --------------------------------------------------
// Database Initialization
// --------------------------------------------------

db.exec(`
    CREATE TABLE IF NOT EXISTS policies (
        id INTEGER PRIMARY KEY,
        version TEXT,
        effective_from TEXT,
        status TEXT,
        content TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY,
        request_no TEXT,
        requester TEXT,
        plant TEXT,
        description TEXT,
        item_code TEXT,
        quantity REAL,
        uom TEXT,
        need_by TEXT,
        urgency TEXT,
        estimated_unit_price REAL,
        capex INTEGER DEFAULT 0,
        status TEXT DEFAULT 'DRAFT',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY,
        request_id INTEGER,
        decision TEXT,
        route TEXT,
        group_value REAL,
        supplier_ids TEXT,
        policy_version TEXT,
        reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY,
        actor TEXT,
        action TEXT,
        entity_type TEXT,
        entity_id TEXT,
        comment TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS suppliers (
        supplier_id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT DEFAULT 'Active',
        rating REAL
    );

    CREATE TABLE IF NOT EXISTS items (
        item_code TEXT PRIMARY KEY,
        description TEXT,
        category TEXT,
        capex INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS po_history (
        id INTEGER PRIMARY KEY,
        item_code TEXT,
        supplier_id TEXT,
        po_date TEXT,
        unit_price REAL,
        quantity REAL,
        on_time REAL,
        quality REAL
    );
`);

// --------------------------------------------------
// Initial Policy Setup
// --------------------------------------------------

const partial = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, 'policy-v5-extracted.json'),
        'utf8'
    )
);

const existingPolicy = db
    .prepare('SELECT 1 FROM policies LIMIT 1')
    .get();

if (!existingPolicy) {
    db.prepare(`
        INSERT INTO policies (
            version,
            effective_from,
            status,
            content
        )
        VALUES (?, ?, ?, ?)
    `).run(
        partial.version,
        partial.effectiveFrom,
        'ACTIVE',
        JSON.stringify(partial)
    );
}

// --------------------------------------------------
// Policy Helper
// --------------------------------------------------

function activePolicy(asOf = new Date().toISOString().slice(0, 10)) {
    const row = db.prepare(`
        SELECT *
        FROM policies
        WHERE status = 'ACTIVE'
          AND effective_from <= ?
        ORDER BY effective_from DESC, id DESC
        LIMIT 1
    `).get(asOf);

    return row
        ? {
            ...row,
            content: JSON.parse(row.content)
        }
        : null;
}

// --------------------------------------------------
// Supplier Recommendation
// --------------------------------------------------

function preferred(itemCode, count = 3) {
    return db.prepare(`
        SELECT
            s.supplier_id,
            s.name,
            s.status,
            s.rating,
            COUNT(h.id) AS po_count,
            MAX(h.po_date) AS last_po,
            AVG(h.unit_price) AS avg_price
        FROM suppliers s
        JOIN po_history h
            ON h.supplier_id = s.supplier_id
        WHERE h.item_code = ?
          AND s.status = 'Active'
        GROUP BY s.supplier_id
        ORDER BY
            po_count DESC,
            last_po DESC,
            s.rating DESC
        LIMIT ?
    `).all(itemCode, count);
}

// --------------------------------------------------
// Procurement Decision Engine
// --------------------------------------------------

function decide(req, policy = activePolicy()) {
    if (!policy) {
        throw new Error('No active policy');
    }

    const p = policy.content;

    const itemKnown = !!req.item_code &&
        !!db.prepare(`
            SELECT 1
            FROM items
            WHERE item_code = ?
        `).get(req.item_code);

    const history = itemKnown &&
        !!db.prepare(`
            SELECT 1
            FROM po_history h
            JOIN suppliers s
                ON s.supplier_id = h.supplier_id
            WHERE h.item_code = ?
              AND s.status = 'Active'
              AND h.po_date >= date(?, '-365 day')
            LIMIT 1
        `).get(
            req.item_code,
            req.created_at || new Date().toISOString().slice(0, 10)
        );

    const value =
        Number(req.quantity || 0) *
        Number(req.estimated_unit_price || 0);

    const context = {
        capex: !!req.capex,
        itemKnown,
        urgency: req.urgency || 'Normal',
        value,
        hasPurchaseHistory: history,
        hasPurchaseHistory365d: history
    };

    const rules = [...(p.rules || [])].sort(
        (a, b) => a.priority - b.priority
    );

    for (const rule of rules) {
        const conditions = rule.when || {};
        let matched = true;

        for (const [key, expectedValue] of Object.entries(conditions)) {
            if (key === 'valueLt') {
                matched = matched && value < expectedValue;
            } else if (key === 'valueLte') {
                matched = matched && value <= expectedValue;
            } else if (key === 'valueGte') {
                matched = matched && value >= expectedValue;
            } else {
                matched = matched && context[key] === expectedValue;
            }
        }

        if (matched) {
            const suppliers = req.item_code
                ? preferred(
                    req.item_code,
                    rule.then.supplierCount || 3
                )
                : [];

            return {
                decision: rule.then.decision,
                route: rule.then.route,
                value,
                suppliers,
                policyVersion: p.version,
                reason: `${rule.id}: ${
                    rule.explanation || 'Matched active policy rule.'
                }`
            };
        }
    }

    return {
        decision: 'SOURCING_REQUEST',
        route: 'RFQ',
        value,
        suppliers: req.item_code
            ? preferred(req.item_code, 3)
            : [],
        policyVersion: p.version,
        reason: 'No configured rule matched. Conservative fallback: sourcing review required.'
    };
}

// --------------------------------------------------
// Audit Logging
// --------------------------------------------------

function audit(actor, action, type, id, comment = '') {
    db.prepare(`
        INSERT INTO audit (
            actor,
            action,
            entity_type,
            entity_id,
            comment
        )
        VALUES (?, ?, ?, ?, ?)
    `).run(actor, action, type, String(id), comment);
}

// --------------------------------------------------
// Health Check API
// --------------------------------------------------

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'corvo-procurement',
        policy: activePolicy()?.content.version
    });
});

// --------------------------------------------------
// Dashboard API
// --------------------------------------------------

app.get('/api/dashboard', (req, res) => {
    const totals = db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(status = 'PENDING') AS pending,
            SUM(status = 'APPROVED') AS approved
        FROM requests
    `).get();

    const recent = db.prepare(`
        SELECT
            r.*,
            d.decision,
            d.route,
            d.group_value,
            d.supplier_ids,
            d.policy_version,
            d.reason
        FROM requests r
        LEFT JOIN decisions d
            ON d.request_id = r.id
        ORDER BY r.id DESC
        LIMIT 30
    `).all();

    res.json({
        totals,
        recent,
        policy: activePolicy()?.content
    });
});

// --------------------------------------------------
// Chat-Based Procurement Request API
// --------------------------------------------------

app.post('/api/chat', (req, res) => {
    const {
        message,
        requester = 'Employee',
        plant,
        quantity,
        need_by,
        urgency = 'Normal',
        item_code,
        estimated_unit_price,
        capex = false
    } = req.body || {};

    if (!message && !quantity) {
        return res.status(400).json({
            error: 'Tell me what you need.'
        });
    }

    const text = String(message || '');

    const qty =
        Number(quantity) ||
        Number((text.match(/\b(\d+(?:\.\d+)?)\b/) || [])[1]) ||
        null;

    const chosenPlant =
        plant ||
        (/chakan/i.test(text) ? 'CHK1' :
            /pune/i.test(text) ? 'PUN1' : null);

    const missing = [];

    if (!qty) {
        missing.push('quantity');
    }

    if (!chosenPlant) {
        missing.push('plant (PUN1 or CHK1)');
    }

    if (!need_by) {
        missing.push('need-by date');
    }

    if (!item_code && !text.trim()) {
        missing.push('item description');
    }

    if (missing.length) {
        return res.json({
            status: 'NEEDS_DETAILS',
            missing,
            reply: `I can start this request. Please provide: ${missing.join(', ')}.`
        });
    }

    const ins = db.prepare(`
        INSERT INTO requests (
            request_no,
            requester,
            plant,
            description,
            item_code,
            quantity,
            uom,
            need_by,
            urgency,
            estimated_unit_price,
            capex,
            status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `).run(
        `PR-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`,
        requester,
        chosenPlant,
        text,
        item_code || null,
        qty,
        'EA',
        need_by,
        urgency,
        Number(estimated_unit_price) || 0,
        capex ? 1 : 0
    );

    const r = db.prepare(`
        SELECT *
        FROM requests
        WHERE id = ?
    `).get(ins.lastInsertRowid);

    const d = decide(r);

    db.prepare(`
        INSERT INTO decisions (
            request_id,
            decision,
            route,
            group_value,
            supplier_ids,
            policy_version,
            reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        r.id,
        d.decision,
        d.route,
        d.value,
        d.suppliers.map(s => s.supplier_id).join(';'),
        d.policyVersion,
        d.reason
    );

    audit(
        requester,
        'REQUEST_CREATED',
        'request',
        r.id,
        'Created through chat'
    );

    res.json({
        status: 'CREATED',
        request: r,
        decision: d,
        reply: `Request ${r.request_no} created. Preliminary route: ${d.route}. ${d.reason}`
    });
});

// --------------------------------------------------
// Request Approval API
// --------------------------------------------------

app.post('/api/requests/:id/approve', (req, res) => {
    const id = Number(req.params.id);
    const actor = req.body.actor || 'Buyer';
    const comment = req.body.comment || '';

    const r = db.prepare(`
        SELECT *
        FROM requests
        WHERE id = ?
    `).get(id);

    if (!r) {
        return res.status(404).json({
            error: 'Request not found'
        });
    }

    db.prepare(`
        UPDATE requests
        SET status = 'APPROVED'
        WHERE id = ?
    `).run(id);

    audit(actor, 'APPROVED', 'request', id, comment);

    res.json({
        ok: true,
        message: 'Approved; downstream PO/RFQ creation is represented by the approved route in this starter.'
    });
});

// --------------------------------------------------
// Request Override API
// --------------------------------------------------

app.post('/api/requests/:id/override', (req, res) => {
    const id = Number(req.params.id);
    const actor = req.body.actor || 'Buyer';
    const comment = String(req.body.comment || '').trim();

    if (!comment) {
        return res.status(400).json({
            error: 'Override comment is required'
        });
    }

    db.prepare(`
        UPDATE requests
        SET status = 'OVERRIDDEN'
        WHERE id = ?
    `).run(id);

    audit(actor, 'OVERRIDE', 'request', id, comment);

    res.json({
        ok: true
    });
});

// --------------------------------------------------
// Policy Management APIs
// --------------------------------------------------

app.get('/api/policy', (req, res) => {
    const active = activePolicy();

    const versions = db.prepare(`
        SELECT
            id,
            version,
            effective_from,
            status,
            created_at
        FROM policies
        ORDER BY id DESC
    `).all();

    res.json({
        active,
        versions
    });
});

// Upload Policy
app.post('/api/policy/upload', upload.single('policy'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            error: 'Upload a JSON policy file for this starter.'
        });
    }

    try {
        const raw = fs.readFileSync(req.file.path, 'utf8');
        const p = JSON.parse(raw);

        if (!p.version || !p.effectiveFrom || !Array.isArray(p.rules)) {
            throw new Error(
                'Policy JSON needs version, effectiveFrom and rules[]'
            );
        }

        const preview = {
            version: p.version,
            effectiveFrom: p.effectiveFrom,
            ruleCount: p.rules.length,
            changes: `New version ${p.version} contains ${p.rules.length} ordered rules. It will become active only after approval and on its effective date.`
        };

        const info = db.prepare(`
            INSERT INTO policies (
                version,
                effective_from,
                status,
                content
            )
            VALUES (?, ?, 'PENDING', ?)
        `).run(
            p.version,
            p.effectiveFrom,
            JSON.stringify(p)
        );

        audit(
            req.body.actor || 'Procurement',
            'POLICY_UPLOADED',
            'policy',
            info.lastInsertRowid,
            'Awaiting approval'
        );

        res.json({
            ok: true,
            id: info.lastInsertRowid,
            preview
        });

    } catch (e) {
        res.status(400).json({
            error: e.message
        });

    } finally {
        fs.unlink(req.file.path, () => {});
    }
});

// Approve Policy
app.post('/api/policy/:id/approve', (req, res) => {
    const id = Number(req.params.id);

    const p = db.prepare(`
        SELECT *
        FROM policies
        WHERE id = ?
    `).get(id);

    if (!p) {
        return res.status(404).json({
            error: 'Policy not found'
        });
    }

    db.prepare(`
        UPDATE policies
        SET status = 'SUPERSEDED'
        WHERE status = 'ACTIVE'
          AND effective_from <= ?
    `).run(p.effective_from);

    db.prepare(`
        UPDATE policies
        SET status = 'ACTIVE'
        WHERE id = ?
    `).run(id);

    audit(
        req.body.actor || 'Procurement',
        'POLICY_ACTIVATED',
        'policy',
        id,
        'Approved; activation governed by effective date'
    );

    res.json({
        ok: true,
        policy: {
            version: p.version,
            effectiveFrom: p.effective_from
        }
    });
});

// --------------------------------------------------
// Batch CSV Processing API
// --------------------------------------------------

app.post('/api/process-batch', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            error: 'Upload sample-format CSV as file'
        });
    }

    try {
        const rows = parse(
            fs.readFileSync(req.file.path, 'utf8'),
            {
                columns: true,
                skip_empty_lines: true,
                trim: true
            }
        );

        const out = rows.map((row, i) => {
            const r = {
                ...row,
                quantity: Number(row.quantity || row.qty || 0),
                estimated_unit_price: Number(
                    row.estimated_unit_price || row.unit_price || 0
                ),
                urgency: row.urgency || 'Normal',
                capex: /^(1|true|yes)$/i.test(row.capex || '')
            };

            const d = decide(r);

            return {
                pr_no: row.pr_no || row.pr_number || '',
                pr_line: row.pr_line || row.line_no || '',
                resolved_item_code: r.item_code || 'NEW',
                group_id: `REQ-${i + 1}`,
                po_id: '',
                decision: d.decision,
                route: d.route,
                supplier_id: '',
                unit_price: '',
                group_value_inr: d.value,
                suggested_supplier_ids: d.suppliers
                    .map(s => s.supplier_id)
                    .join(';'),
                policy_version: d.policyVersion,
                reason: d.reason
            };
        });

        const headers = Object.keys(
            out[0] || {
                pr_no: '',
                pr_line: ''
            }
        );

        const csv = [
            headers.join(','),
            ...out.map(row =>
                headers.map(key =>
                    `"${String(row[key] ?? '').replace(/"/g, '""')}"`
                ).join(',')
            )
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');

        res.setHeader(
            'Content-Disposition',
            'attachment; filename="procurement-decisions.csv"'
        );

        res.send(csv);

    } catch (e) {
        res.status(400).json({
            error: e.message
        });

    } finally {
        fs.unlink(req.file.path, () => {});
    }
});

// --------------------------------------------------
// Audit History API
// --------------------------------------------------

app.get('/api/audit', (req, res) => {
    const records = db.prepare(`
        SELECT *
        FROM audit
        ORDER BY id DESC
        LIMIT 200
    `).all();

    res.json(records);
});

// --------------------------------------------------
// Start Server
// --------------------------------------------------

app.listen(PORT, () => {
    console.log(
        `Corvo Procurement running at http://localhost:${PORT}`
    );
});
