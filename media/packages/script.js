// @ts-nocheck
const vscode = acquireVsCodeApi();
let packages = [];
let currentFilter = 'popular';
let isSearchMode = false;
let currentPage = 1;
let isLoadingMore = false;
let hasMorePages = true;

const filterLabels = {
    'popular': 'Popular Packages',
    'favorites': 'Flutter Favorites',
    'trending': 'Trending Packages',
    'top-rated': 'Top Rated Packages',
    'new': 'New Packages',
    'updated': 'Recently Updated',
    'android': 'Android Packages',
    'ios': 'iOS Packages',
    'web': 'Web Packages',
    'windows': 'Windows Packages',
    'macos': 'macOS Packages',
    'linux': 'Linux Packages',
    'ui': 'UI Components',
    'state': 'State Management',
    'networking': 'Networking',
    'storage': 'Storage',
    'firebase': 'Firebase',
    'utils': 'Utilities'
};

function openFilterScreen() {
    document.getElementById('listScreen').classList.add('hidden');
    document.getElementById('filterScreen').classList.add('active');
    window.scrollTo(0, 0);
}

function closeFilterScreen() {
    document.getElementById('filterScreen').classList.remove('active');
    document.getElementById('listScreen').classList.remove('hidden');
}

function applyFilter(filter) {
    currentFilter = filter;
    isSearchMode = false;
    currentPage = 1;
    hasMorePages = true;

    // Update filter chip
    const filterChip = document.getElementById('activeFilter');
    const filterName = document.getElementById('activeFilterName');
    filterChip.style.display = 'inline-flex';
    filterName.textContent = filterLabels[filter] || filter;

    // Show browse button, hide clear button
    document.getElementById('actionRow').style.display = 'flex';
    document.getElementById('clearRow').style.display = 'none';
    document.getElementById('searchInput').value = '';

    // Close filter screen and show list
    closeFilterScreen();

    // Request packages
    vscode.postMessage({ command: 'loadFilter', filter, page: 1 });
}

function clearFilter() {
    currentFilter = 'popular';
    currentPage = 1;
    hasMorePages = true;
    document.getElementById('activeFilter').style.display = 'none';
    vscode.postMessage({ command: 'loadFilter', filter: 'popular', page: 1 });
}

function loadMore() {
    if (isLoadingMore || !hasMorePages) return;

    isLoadingMore = true;
    currentPage++;
    document.getElementById('loadingMore').style.display = 'flex';

    if (isSearchMode) {
        const query = document.getElementById('searchInput').value.trim();
        vscode.postMessage({ command: 'searchMore', query, page: currentPage });
    } else {
        vscode.postMessage({ command: 'loadFilterMore', filter: currentFilter, page: currentPage });
    }
}

// Infinite scroll - load more when near bottom
window.addEventListener('scroll', () => {
    const listScreen = document.getElementById('listScreen');
    if (listScreen.classList.contains('hidden')) return;

    const scrollTop = window.scrollY;
    const windowHeight = window.innerHeight;
    const documentHeight = document.documentElement.scrollHeight;

    // Load more when within 200px of the bottom
    if (documentHeight - scrollTop - windowHeight < 200) {
        loadMore();
    }
});

function clearSearch() {
    isSearchMode = false;
    currentPage = 1;
    hasMorePages = true;
    document.getElementById('searchInput').value = '';
    document.getElementById('actionRow').style.display = 'flex';
    document.getElementById('clearRow').style.display = 'none';

    // Show filter chip if there was a filter
    if (currentFilter !== 'popular') {
        document.getElementById('activeFilter').style.display = 'inline-flex';
        document.getElementById('activeFilterName').textContent = filterLabels[currentFilter] || currentFilter;
    }

    vscode.postMessage({ command: 'loadFilter', filter: currentFilter, page: 1 });
}

document.getElementById('searchInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        search();
    }
});

function search() {
    const query = document.getElementById('searchInput').value.trim();
    if (query) {
        isSearchMode = true;
        currentPage = 1;
        hasMorePages = true;
        document.getElementById('actionRow').style.display = 'none';
        document.getElementById('clearRow').style.display = 'flex';
        document.getElementById('activeFilter').style.display = 'none';
        vscode.postMessage({ command: 'search', query, page: 1 });
    }
}

function addPackage(packageName, version) {
    vscode.postMessage({ command: 'addPackage', packageName, version });
}

function showDetails(packageName) {
    if (!isNavigatingBack && currentPackageName && currentPackageName !== packageName) {
        navigationStack.push(currentPackageName);
    }
    isNavigatingBack = false;
    vscode.postMessage({ command: 'getDetails', packageName });
}

function viewOnPubDev(packageName) {
    vscode.postMessage({ command: 'viewOnPubDev', packageName });
}

function copyToClipboard(text, buttonId) {
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById(buttonId);
        const originalContent = btn.innerHTML;
        const isIconBtn = btn.classList.contains('icon-btn');

        if (isIconBtn) {
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        } else {
            btn.innerHTML = '✓ Copied';
        }
        btn.classList.add('copied');

        setTimeout(() => {
            btn.innerHTML = originalContent;
            btn.classList.remove('copied');
        }, 2000);
    });
}

let currentPackageName = '';
let navigationStack = [];
let isNavigatingBack = false;

function updateVersionCommand() {
    const select = document.getElementById('versionSelect');
    const content = document.getElementById('versionCmdContent');
    if (select && content && currentPackageName) {
        content.innerHTML = '<span class="terminal-prompt">$</span> flutter pub add ' + currentPackageName + ':' + select.value;
    }
}

function goBack() {
    if (navigationStack.length > 0) {
        const previousPackage = navigationStack.pop();
        isNavigatingBack = true;
        vscode.postMessage({ command: 'getDetails', packageName: previousPackage });
    } else {
        currentPackageName = '';
        document.getElementById('listScreen').classList.remove('hidden');
        document.getElementById('detailsScreen').classList.remove('active');
    }
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

function showDetailsScreen(details, score) {
    const listScreen = document.getElementById('listScreen');
    const detailsScreen = document.getElementById('detailsScreen');
    const detailsContent = document.getElementById('detailsContent');

    const versions = details.versions?.slice().reverse().slice(0, 10) || [];
    const pubspec = details.latest?.pubspec || {};
    const environment = pubspec.environment || {};
    const dependencies = pubspec.dependencies || {};
    const published = details.latest?.published;

    // Extract platforms from tags
    const platforms = score?.tags?.filter(t => t.startsWith('platform:')).map(t => t.replace('platform:', '')) || [];
    const isFlutterFavorite = score?.tags?.includes('is:flutter-favorite');
    const isNullSafe = score?.tags?.includes('is:null-safe');
    const license = score?.tags?.find(t => t.startsWith('license:'))?.replace('license:', '').toUpperCase();

    // Get dependencies (exclude flutter sdk)
    const depList = Object.entries(dependencies)
        .filter(([name, value]) => typeof value === 'string')
        .slice(0, 8);

    detailsContent.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
            <div class="details-title">${details.name}</div>
            <button class="add-app-btn" onclick="addPackage('${details.name}')" title="Run flutter pub add ${details.name}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                Add to Application
            </button>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
            <span class="package-version">v${details.latest?.version || 'N/A'}</span>
            ${isFlutterFavorite ? '<span class="tag flutter-favorite">Flutter Favorite</span>' : ''}
            ${isNullSafe ? '<span class="tag null-safe">Null Safe</span>' : ''}
            <button class="details-btn" onclick="viewOnPubDev('${details.name}')">
                View on pub.dev
            </button>
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

            ${environment.sdk || environment.flutter ? `
            <div class="details-section">
                <div class="details-section-title">SDK Constraints</div>
                <div class="details-section-content">
                    ${environment.sdk ? `<div class="sdk-constraint">Dart: ${environment.sdk}</div>` : ''}
                    ${environment.flutter ? `<div class="sdk-constraint">Flutter: ${environment.flutter}</div>` : ''}
                </div>
            </div>
            ` : ''}

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

            <div class="details-section">
                <div class="details-section-title">Add to pubspec.yaml</div>
                <div class="terminal-box">
                    <div class="terminal-header">
                        <span class="terminal-title">pubspec.yaml</span>
                        <div class="terminal-actions">
                            <button class="terminal-btn copy-btn" id="copyDep" onclick="copyToClipboard('${details.name}: ^${details.latest?.version || ''}', 'copyDep')">
                                Copy
                            </button>
                        </div>
                    </div>
                    <div class="terminal-content">dependencies:\n  ${details.name}: ^${details.latest?.version || ''}</div>
                </div>
            </div>

            <div class="details-section">
                <div class="details-section-title">Install via Terminal</div>
                <div class="terminal-box">
                    <div class="terminal-header">
                        <span class="terminal-title">Terminal</span>
                        <div class="terminal-actions">
                            <button class="terminal-btn copy-btn" id="copyCmd" onclick="copyToClipboard('flutter pub add ${details.name}', 'copyCmd')">
                                Copy
                            </button>
                            <button class="terminal-btn run-btn" onclick="addPackage('${details.name}')">
                                Run
                            </button>
                        </div>
                    </div>
                    <div class="terminal-content"><span class="terminal-prompt">$</span> flutter pub add ${details.name}</div>
                </div>
            </div>

            <div class="details-section">
                <div class="details-section-title">Install Specific Version</div>
                <div class="terminal-box">
                    <div class="terminal-header">
                        <span class="terminal-title">Terminal</span>
                        <div class="terminal-actions">
                            <select class="version-select" id="versionSelect" onchange="updateVersionCommand()">
                                ${versions.map(v => `<option value="${v.version}">${v.version}</option>`).join('')}
                            </select>
                            <button class="terminal-btn copy-btn" id="copyVerCmd" onclick="copyToClipboard('flutter pub add ${details.name}:' + document.getElementById('versionSelect').value, 'copyVerCmd')">
                                Copy
                            </button>
                            <button class="terminal-btn run-btn" onclick="addPackage('${details.name}', document.getElementById('versionSelect').value)">
                                Run
                            </button>
                        </div>
                    </div>
                    <div class="terminal-content" id="versionCmdContent"><span class="terminal-prompt">$</span> flutter pub add ${details.name}:${versions[0]?.version || details.latest?.version}</div>
                </div>
            </div>

            ${depList.length > 0 ? `
            <div class="details-section" style="margin-top: 24px;">
                <div class="details-section-title">Dependencies (${Object.keys(dependencies).length})</div>
                <div class="dependency-list">
                    ${depList.map(([name, version]) => `<div class="dependency-item clickable" onclick="showDetails('${name}')">${name}: ${version}</div>`).join('')}
                    ${Object.keys(dependencies).length > 8 ? `<div class="dependency-item" style="color: var(--vscode-descriptionForeground);">... and ${Object.keys(dependencies).length - 8} more</div>` : ''}
                </div>
            </div>
            ` : ''}

            ${license ? `
            <div class="details-section">
                <div class="details-section-title">License</div>
                <div class="details-section-content">${license}</div>
            </div>
            ` : ''}
        </div>
    `;

    currentPackageName = details.name;
    isNavigatingBack = false;
    listScreen.classList.add('hidden');
    detailsScreen.classList.add('active');
    window.scrollTo(0, 0);
}

window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.command) {
        case 'update':
            if (message.loading) {
                document.getElementById('content').innerHTML = `
                    <div class="loading">
                        <div class="spinner"></div>
                        Loading packages...
                    </div>
                `;
            } else if (message.error) {
                document.getElementById('content').innerHTML = `
                    <div class="error">${message.error}</div>
                `;
            } else if (message.packages) {
                packages = message.packages;
                hasMorePages = message.hasMore !== false;
                renderPackages(packages);
            }
            break;

        case 'packagesMore':
            isLoadingMore = false;
            document.getElementById('loadingMore').style.display = 'none';

            if (message.packages && message.packages.length > 0) {
                packages = packages.concat(message.packages);
                hasMorePages = message.hasMore !== false;
                appendPackages(message.packages);
            } else {
                hasMorePages = false;
            }
            break;

        case 'packageDetails':
            showDetailsScreen(message.details, message.score);
            break;
    }
});

function renderPackages(packages) {
    const content = document.getElementById('content');

    if (!packages || packages.length === 0) {
        content.innerHTML = '<div class="loading">No packages found</div>';
        return;
    }

    content.innerHTML = packages.map(pkg => renderPackageCard(pkg)).join('');
}

function appendPackages(newPackages) {
    const content = document.getElementById('content');
    const html = newPackages.map(pkg => renderPackageCard(pkg)).join('');
    content.insertAdjacentHTML('beforeend', html);
}

function renderPackageCard(pkg) {
    const details = pkg.details;
    const name = pkg.package;
    const version = details?.latest?.version || '';
    const description = details?.latest?.pubspec?.description || 'No description available';

    return `
        <div class="package-card" onclick="showDetails('${name}')">
            <div class="package-header">
                <span class="package-name">${name}</span>
                ${version ? `<span class="package-version">v${version}</span>` : ''}
            </div>
            <div class="package-description">${escapeHtml(description)}</div>
            <div class="package-actions">
                <button class="add-btn" onclick="event.stopPropagation(); addPackage('${name}')">
                    flutter pub add
                </button>
            </div>
        </div>
    `;
}
