// @ts-nocheck
const vscode = acquireVsCodeApi();
let packages = [];
let currentPackageName = '';

function refresh() {
    vscode.postMessage({ command: 'refresh' });
}

function updatePackage(packageName, version, event) {
    if (event) event.stopPropagation();
    vscode.postMessage({ command: 'updatePackage', packageName, version });
}

function removePackage(packageName, event) {
    if (event) event.stopPropagation();
    vscode.postMessage({ command: 'removePackage', packageName });
}

function showDetails(packageName) {
    currentPackageName = packageName;
    vscode.postMessage({ command: 'getDetails', packageName });
}

function viewOnPubDev(packageName) {
    vscode.postMessage({ command: 'viewOnPubDev', packageName });
}

function goBack() {
    currentPackageName = '';
    document.getElementById('listScreen').classList.remove('hidden');
    document.getElementById('detailsScreen').classList.remove('active');
}

function copyToClipboard(text, buttonId) {
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById(buttonId);
        const originalContent = btn.innerHTML;
        btn.innerHTML = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.innerHTML = originalContent;
            btn.classList.remove('copied');
        }, 2000);
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num?.toString() || '0';
}

function formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderPackages(pkgs) {
    packages = pkgs;
    const content = document.getElementById('content');
    const statsBar = document.getElementById('statsBar');

    if (!pkgs || pkgs.length === 0) {
        statsBar.style.display = 'none';
        content.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📦</div>
                <div>No packages found in pubspec.yaml</div>
            </div>
        `;
        return;
    }

    // Update stats
    const total = pkgs.length;
    const outdated = pkgs.filter(p => p.isOutdated).length;
    const discontinued = pkgs.filter(p => p.isDiscontinued).length;
    const deprecated = pkgs.filter(p => p.isDeprecated).length;

    document.getElementById('totalCount').textContent = total;
    document.getElementById('outdatedCount').textContent = outdated;
    document.getElementById('discontinuedCount').textContent = discontinued;
    document.getElementById('deprecatedCount').textContent = deprecated;
    statsBar.style.display = 'flex';

    content.innerHTML = '<div class="package-list">' + pkgs.map(pkg => {
        const statusClass = pkg.isDeprecated || pkg.isDiscontinued ? 'deprecated' : (pkg.isOutdated ? 'outdated' : '');

        let statusIcon = '';
        if (pkg.isDiscontinued) {
            statusIcon = '<span class="status-icon error"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> Discontinued</span>';
        } else if (pkg.isDeprecated) {
            statusIcon = '<span class="status-icon error"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> Deprecated</span>';
        } else if (pkg.isOutdated) {
            statusIcon = '<span class="status-icon warning"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-8h2v8z"/></svg> Update available</span>';
        }

        return `
            <div class="package-card ${statusClass}" onclick="showDetails('${pkg.name}')">
                <div class="package-header">
                    <div class="package-name-row">
                        <span class="package-name">${pkg.name}</span>
                        ${statusIcon}
                    </div>
                    <div class="version-info">
                        <span class="current-version">${pkg.currentVersion}</span>
                        ${pkg.latestVersion && pkg.isOutdated ? `
                            <span class="version-arrow">→</span>
                            <span class="latest-version">${pkg.latestVersion}</span>
                        ` : ''}
                    </div>
                </div>
                <div class="package-actions">
                    ${pkg.isOutdated && pkg.latestVersion ? `
                        <button class="action-btn update-btn" onclick="updatePackage('${pkg.name}', '${pkg.latestVersion}', event)">
                            Update to ${pkg.latestVersion}
                        </button>
                    ` : ''}
                    <button class="action-btn remove-btn" onclick="removePackage('${pkg.name}', event)">
                        Remove
                    </button>
                    <button class="action-btn view-btn" onclick="event.stopPropagation(); viewOnPubDev('${pkg.name}')">
                        pub.dev
                    </button>
                </div>
            </div>
        `;
    }).join('') + '</div>';
}

function showDetailsScreen(details, score, currentVersion) {
    const listScreen = document.getElementById('listScreen');
    const detailsScreen = document.getElementById('detailsScreen');
    const detailsContent = document.getElementById('detailsContent');

    const pubspec = details.latest?.pubspec || {};
    const published = details.latest?.published;
    const latestVersion = details.latest?.version;
    const isDiscontinued = score?.tags?.includes('is:discontinued');
    const isDeprecated = score?.tags?.includes('is:deprecated') || isDiscontinued;
    const platforms = score?.tags?.filter(t => t.startsWith('platform:')).map(t => t.replace('platform:', '')) || [];

    const installedPkg = packages.find(p => p.name === details.name);
    const isOutdated = installedPkg?.isOutdated || false;

    detailsContent.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px;">
            <div class="details-title">${details.name}</div>
            ${isDiscontinued ? '<span class="tag discontinued">Discontinued</span>' : ''}
            ${isDeprecated && !isDiscontinued ? '<span class="tag deprecated">Deprecated</span>' : ''}
        </div>

        <div class="version-comparison ${isOutdated ? 'has-update' : ''}">
            <div class="version-box current">
                <div class="label">Installed</div>
                <div class="value">${currentVersion || 'unknown'}</div>
            </div>
            ${isOutdated ? '<div class="version-arrow-lg">→</div>' : ''}
            <div class="version-box latest">
                <div class="label">Latest</div>
                <div class="value">${latestVersion || 'N/A'}</div>
            </div>
        </div>

        <div class="details-content">
            ${score ? `
            <div class="stats-row">
                <div class="stat-item">
                    <div class="stat-value">${formatNumber(score.likeCount)}</div>
                    <div class="stat-label">Likes</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${score.grantedPoints}/${score.maxPoints}</div>
                    <div class="stat-label">Pub Points</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value">${formatNumber(score.downloadCount30Days)}</div>
                    <div class="stat-label">Monthly Downloads</div>
                </div>
            </div>
            ` : ''}

            <div class="details-section">
                <div class="details-section-title">Description</div>
                <div class="details-section-content">${escapeHtml(pubspec.description || 'No description available')}</div>
            </div>

            <div class="details-section">
                <div class="details-section-title">Published</div>
                <div class="details-section-content">${formatDate(published)}</div>
            </div>

            ${platforms.length > 0 ? `
            <div class="details-section">
                <div class="details-section-title">Platforms</div>
                <div class="tag-container">
                    ${platforms.map(p => `<span class="tag platform">${p}</span>`).join('')}
                </div>
            </div>
            ` : ''}

            ${isOutdated && latestVersion ? `
            <div class="details-section">
                <div class="details-section-title">Update Package</div>
                <div class="terminal-box">
                    <div class="terminal-header">
                        <span class="terminal-title">Terminal</span>
                        <div class="terminal-actions">
                            <button class="terminal-btn copy-btn" id="copyUpdateCmd" onclick="copyToClipboard('flutter pub add ${details.name}:${latestVersion}', 'copyUpdateCmd')">
                                Copy
                            </button>
                            <button class="terminal-btn run-btn" onclick="updatePackage('${details.name}', '${latestVersion}')">
                                Run
                            </button>
                        </div>
                    </div>
                    <div class="terminal-content"><span class="terminal-prompt">$</span> flutter pub add ${details.name}:${latestVersion}</div>
                </div>
            </div>
            ` : ''}

            <div class="details-section">
                <div class="details-section-title">Remove Package</div>
                <div class="terminal-box">
                    <div class="terminal-header">
                        <span class="terminal-title">Terminal</span>
                        <div class="terminal-actions">
                            <button class="terminal-btn copy-btn" id="copyRemoveCmd" onclick="copyToClipboard('flutter pub remove ${details.name}', 'copyRemoveCmd')">
                                Copy
                            </button>
                            <button class="terminal-btn run-btn" onclick="removePackage('${details.name}')">
                                Run
                            </button>
                        </div>
                    </div>
                    <div class="terminal-content"><span class="terminal-prompt">$</span> flutter pub remove ${details.name}</div>
                </div>
            </div>

            ${pubspec.homepage ? `
            <div class="details-section">
                <div class="details-section-title">Homepage</div>
                <div class="details-section-content">
                    <a href="${pubspec.homepage}" class="details-link">${pubspec.homepage}</a>
                </div>
            </div>
            ` : ''}

            ${pubspec.repository ? `
            <div class="details-section">
                <div class="details-section-title">Repository</div>
                <div class="details-section-content">
                    <a href="${pubspec.repository}" class="details-link">${pubspec.repository}</a>
                </div>
            </div>
            ` : ''}
        </div>
    `;

    listScreen.classList.add('hidden');
    detailsScreen.classList.add('active');
    window.scrollTo(0, 0);
}

window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.command) {
        case 'update':
            if (message.loading) {
                document.getElementById('statsBar').style.display = 'none';
                document.getElementById('content').innerHTML = `
                    <div class="loading">
                        <div class="spinner"></div>
                        Loading installed packages...
                    </div>
                `;
            } else if (message.error) {
                document.getElementById('statsBar').style.display = 'none';
                document.getElementById('content').innerHTML = `
                    <div class="error">${message.error}</div>
                `;
            } else if (message.empty) {
                document.getElementById('statsBar').style.display = 'none';
                document.getElementById('content').innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon">📦</div>
                        <div>No packages found in pubspec.yaml</div>
                    </div>
                `;
            } else if (message.packages) {
                renderPackages(message.packages);
            }
            break;

        case 'packageDetails':
            showDetailsScreen(message.details, message.score, message.currentVersion);
            break;
    }
});
