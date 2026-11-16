
const $ = selector => document.querySelector(selector);
let latest = [];

// Switch between dashboard sections
function show(id) {
    document.querySelectorAll('.view').forEach(view => {
        view.classList.toggle('active', view.id === id);
    });

    document.querySelectorAll('.nav').forEach(button => {
        button.classList.toggle('active', button.dataset.view === id);
    });

    const pageTitles = {
        overview: 'Overview',
        requests: 'Buyer workspace',
        chat: 'New request',
        policy: 'Policy management',
        batch: 'Batch processing',
        audit: 'Audit trail'
    };

    $('#pageTitle').textContent = pageTitles[id];

    if (id === 'overview' || id === 'requests') loadDashboard();
    if (id === 'policy') loadPolicy();
    if (id === 'audit') loadAudit();
}

// Handle sidebar navigation
document.querySelectorAll('.nav').forEach(button => {
    button.onclick = () => show(button.dataset.view);
});

// Format amounts in Indian currency
const money = amount =>
    '₹' + Number(amount || 0).toLocaleString('en-IN', {
        maximumFractionDigits: 0
    });

// Display requests in a table
function table(rows) {
    if (!rows.length) {
        return '<div class="empty">No requests yet. Start by raising a purchase request.</div>';
    }

    return `
        <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>Request</th>
                        <th>Item / description</th>
                        <th>Plant</th>
                        <th>Value</th>
                        <th>Decision</th>
                        <th>Policy reason</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(request => `
                        <tr>
                            <td class="strong">
                                ${request.request_no || request.pr_no || '—'}
                            </td>
                            <td>
                                ${request.description || '—'}<br>
                                <small>${request.item_code || 'Unmatched item'}</small>
                            </td>
                            <td>${request.plant || '—'}</td>
                            <td>${money(request.group_value || request.group_value_inr)}</td>
                            <td>
                                <span class="pill ${request.decision === 'PO' ? 'green' : 'amber'}">
                                    ${request.route || request.decision || 'Pending'}
                                </span>
                            </td>
                            <td class="reason">
                                ${request.reason || 'Awaiting decision'}
                            </td>
                            <td>
                                ${request.id
                                    ? `<button class="action" onclick="approve(${request.id})">Approve</button>`
                                    : '—'}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// Load dashboard data
async function loadDashboard() {
    const response = await fetch('/api/dashboard');
    const data = await response.json();

    latest = data.recent || [];

    $('#stats').innerHTML = `
        <div class="stat">
            <span>Total requests</span>
            <b>${data.totals.total || 0}</b>
        </div>
        <div class="stat">
            <span>Pending buyer action</span>
            <b>${data.totals.pending || 0}</b>
        </div>
        <div class="stat">
            <span>Approved</span>
            <b>${data.totals.approved || 0}</b>
        </div>
    `;

    $('#recent').innerHTML = table(latest.slice(0, 6));
    $('#allRequests').innerHTML = table(latest);

    $('#policyStatus').textContent =
        `Active version: ${data.policy?.version || 'Unavailable'} · ` +
        `Effective ${data.policy?.effectiveFrom || '—'} · Starter policy is partial.`;
}

// Approve a purchase request
async function approve(id) {
    if (!confirm('Approve this request and record the action?')) return;

    const response = await fetch(`/api/requests/${id}/approve`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            actor: 'Procurement buyer'
        })
    });

    const data = await response.json();

    alert(data.message || data.error || 'Saved');
    loadDashboard();
}

// Add a message to the chat window
function addMessage(message, sender) {
    const element = document.createElement('div');

    element.className = `bubble ${sender}`;
    element.textContent = message;

    $('#messages').append(element);
    element.scrollIntoView({ block: 'end' });
}

// Handle purchase request chat
$('#chatForm').onsubmit = async event => {
    event.preventDefault();

    const message = $('#chatInput').value.trim();

    if (!message) return;

    addMessage(message, 'user');
    $('#chatInput').value = '';

    const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message,
            requester: 'Employee'
        })
    });

    const data = await response.json();

    addMessage(data.reply || data.error, 'bot');

    if (data.status === 'CREATED') {
        addMessage(
            `Decision: ${data.decision.route} · ` +
            `Estimated requirement value ${money(data.decision.value)}. ` +
            `${data.decision.suppliers?.length
                ? 'Suggested supplier(s): ' +
                  data.decision.suppliers.map(supplier => supplier.supplier_id).join(', ')
                : ''}`,
            'bot'
        );

        loadDashboard();
    }
};

// Load available policy versions
async function loadPolicy() {
    const response = await fetch('/api/policy');
    const data = await response.json();

    $('#policyVersions').innerHTML = `
        <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>Version</th>
                        <th>Effective date</th>
                        <th>Status</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.versions.map(policy => `
                        <tr>
                            <td class="strong">${policy.version}</td>
                            <td>${policy.effective_from}</td>
                            <td>
                                <span class="pill ${policy.status === 'ACTIVE' ? 'green' : 'amber'}">
                                    ${policy.status}
                                </span>
                            </td>
                            <td>
                                ${policy.status === 'PENDING'
                                    ? `<button class="action" onclick="activatePolicy(${policy.id})">Approve & activate</button>`
                                    : '—'}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// Upload a new policy file
$('#uploadPolicy').onclick = async () => {
    const file = $('#policyFile').files[0];

    if (!file) {
        return alert('Choose a JSON policy file');
    }

    const formData = new FormData();
    formData.append('policy', file);

    const response = await fetch('/api/policy/upload', {
        method: 'POST',
        body: formData
    });

    const data = await response.json();

    $('#policyPreview').textContent = data.preview
        ? `${data.preview.changes} Review before approving.`
        : data.error;

    loadPolicy();
};

// Approve and activate a policy
async function activatePolicy(id) {
    if (!confirm('Approve this policy version?')) return;

    const response = await fetch(`/api/policy/${id}/approve`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            actor: 'Procurement'
        })
    });

    const data = await response.json();

    alert(data.ok ? 'Policy activated.' : data.error);
    loadPolicy();
}

// Process and export a purchase request batch
$('#processBatch').onclick = async () => {
    const file = $('#batchFile').files[0];

    if (!file) {
        return alert('Choose a CSV file');
    }

    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch('/api/process-batch', {
        method: 'POST',
        body: formData
    });

    if (!response.ok) {
        const data = await response.json();
        $('#batchStatus').textContent = data.error;
        return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = 'procurement-decisions.csv';
    link.click();

    URL.revokeObjectURL(url);

    $('#batchStatus').textContent = 'Decision export downloaded.';
};

// Load procurement audit history
async function loadAudit() {
    const response = await fetch('/api/audit');
    const rows = await response.json();

    $('#auditRows').innerHTML = rows.length
        ? `
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>When</th>
                            <th>Actor</th>
                            <th>Action</th>
                            <th>Entity</th>
                            <th>Comment</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(event => `
                            <tr>
                                <td>${event.created_at}</td>
                                <td>${event.actor}</td>
                                <td>${event.action}</td>
                                <td>${event.entity_type} #${event.entity_id}</td>
                                <td>${event.comment}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `
        : '<div class="empty">No audit events yet.</div>';
}

// Load dashboard when the application starts
loadDashboard();