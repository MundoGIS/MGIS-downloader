// Hides the LMV credential form when an admin has saved a shared account on the server.
(function () {
    let configured = false;
    let override = null;

    window.lmvUsesSavedAccount = () => configured && !(override && override.checked);

    async function init() {
        try {
            const response = await fetch('/lmv/account');
            const data = await response.json();
            configured = Boolean(response.ok && data.account?.configured);
            if (!configured) return;
            const authRow = document.querySelector('.auth-row');
            const notice = document.createElement('div');
            notice.className = 'lmv-saved-account';
            const text = document.createElement('div');
            text.textContent = data.account.authType === 'token'
                ? 'Ett sparat LMV-token används automatiskt.'
                : `Sparat LMV-konto används automatiskt (${data.account.username}).`;
            const label = document.createElement('label');
            override = document.createElement('input');
            override.type = 'checkbox';
            label.append(override, 'Använd egna LMV-uppgifter i stället');
            notice.append(text, label);
            const authLabel = authRow?.previousElementSibling?.tagName === 'LABEL' ? authRow.previousElementSibling : null;
            const anchor = authLabel || authRow;
            anchor?.parentNode.insertBefore(notice, anchor);
            const toggle = () => {
                for (const element of [authRow, authLabel]) if (element) element.style.display = override.checked ? '' : 'none';
            };
            override.addEventListener('change', () => { toggle(); document.dispatchEvent(new Event('lmv-account-ready')); });
            toggle();
        } catch (error) {
            console.warn('Kunde inte läsa sparat LMV-konto:', error.message);
        } finally {
            document.dispatchEvent(new Event('lmv-account-ready'));
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
