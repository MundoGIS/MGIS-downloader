document.addEventListener('DOMContentLoaded', async () => {
    for (const key of ['lmv_username', 'lmv_apikey', 'lmv_token', 'lmv_remember', 'lmv_hojd_username', 'lmv_hojd_apikey', 'lmv_hojd_token', 'lmv_hojd_remember']) {
        localStorage.removeItem(key);
    }
    const mount = document.getElementById('site-header');
    if (!mount) return;
    const sections = [
        ['index.html', 'Hem'],
        ['artdata.html', 'ArtData'],
        ['lmv.html', 'Vektordata'],
        ['lmv_hojd.html', 'Höjddata'],
        ['downloads.html', 'Nedladdningar'],
        ['hjalp.html', 'Hjälp']
    ];
    const header = document.createElement('header');
    header.className = 'main-header';
    const inner = document.createElement('div');
    inner.className = 'header-inner';
    const brand = document.createElement('a');
    brand.className = 'brand-wrap';
    brand.href = '/index.html';
    const logo = document.createElement('img');
    logo.src = '/images/MGIS-logo_azul_.png';
    logo.alt = 'MGIS';
    logo.className = 'site-logo';
    const title = document.createElement('span');
    title.className = 'brand';
    title.textContent = 'LMV Data Downloader';
    brand.append(logo, title);
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Huvudmeny');
    const current = location.pathname.split('/').pop() || 'index.html';
    for (const [href, label] of sections) {
        const link = document.createElement('a');
        link.href = '/' + href;
        link.textContent = label;
        if (href === current) {
            link.className = 'active';
            link.setAttribute('aria-current', 'page');
        }
        nav.append(link);
    }
    const account = document.createElement('div');
    account.className = 'header-account';
    inner.append(brand, nav, account);
    header.append(inner);
    mount.replaceWith(header);
    try {
        const response = await fetch('/auth/me');
        if (!response.ok) return;
        const { user } = await response.json();
        if (user.role === 'admin') {
            const link = document.createElement('a');
            link.href = '/admin.html';
            link.textContent = 'Användare';
            account.append(link);
        }
        const button = document.createElement('button');
        button.type = 'button';
        const username = document.createElement('span');
        username.className = 'account-name';
        username.textContent = user.username;
        username.title = user.username;
        account.append(username);
        button.textContent = 'Logga ut';
        button.addEventListener('click', async () => {
            const result = await fetch('/auth/logout', { method: 'POST' });
            if (result.ok) location.assign('/login.html');
        });
        account.append(button);
    } catch (error) {
        console.warn('Kunde inte läsa användarsession:', error);
    }
});