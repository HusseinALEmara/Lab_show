// Settings button and panel, shared by every window: language, appearance (day /
// night / match system) and blocking pop-up notifications while broadcasting.
// The button floats in the bottom corner on the reading-start side, kept away from
// the edges by a share of the window size, and scales with the space available.
(function () {
    'use strict';

    const I18n = window.LabShowI18n;
    const api = window.electronAPI;
    const THEME_KEY = 'labshow.theme';
    const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

    function storedTheme() {
        try {
            const value = localStorage.getItem(THEME_KEY);
            return ['system', 'dark', 'light'].includes(value) ? value : 'system';
        } catch (error) {
            return 'system';
        }
    }

    let theme = storedTheme();

    function applyTheme() {
        const resolved = theme === 'system' ? (media && media.matches ? 'light' : 'dark') : theme;
        document.documentElement.dataset.theme = resolved;
    }
    applyTheme();
    if (media && media.addEventListener) media.addEventListener('change', applyTheme);

    function element(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        Object.entries(props).forEach(([key, value]) => {
            if (key === 'dataset') Object.assign(node.dataset, value);
            else if (key in node) node[key] = value;
            else node.setAttribute(key, value);
        });
        node.append(...children);
        return node;
    }

    function segmented(name, options, current, onPick) {
        const group = element('div', { className: 'segmented settings-segmented', role: 'radiogroup' });
        options.forEach(([value, key]) => {
            const button = element('button', { type: 'button', dataset: { value, i18n: key }, role: 'radio' });
            button.addEventListener('click', () => {
                onPick(value);
                group.querySelectorAll('button').forEach((b) => {
                    b.classList.toggle('active', b === button);
                    b.setAttribute('aria-checked', String(b === button));
                });
            });
            const on = value === current;
            button.classList.toggle('active', on);
            button.setAttribute('aria-checked', String(on));
            group.append(button);
        });
        group.dataset.name = name;
        return group;
    }

    function build() {
        const button = element('button', {
            type: 'button', id: 'settingsButton', className: 'settings-fab',
            dataset: { i18nTitle: 'settings.open' }, 'aria-haspopup': 'dialog', 'aria-expanded': 'false'
        });
        button.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
            '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

        const notifyBox = element('input', { type: 'checkbox', id: 'settingsNotifications' });
        const notifyHint = element('p', { className: 'hint', id: 'settingsNotificationsHint', dataset: { i18n: 'settings.notificationsHint' } });
        const notifyRow = element('label', { className: 'settings-toggle', htmlFor: 'settingsNotifications' }, [
            notifyBox, element('span', { dataset: { i18n: 'settings.notifications' } })
        ]);

        const close = element('button', { type: 'button', className: 'btn-ghost small', dataset: { i18n: 'settings.close' } });
        const panel = element('div', {
            className: 'settings-panel card', id: 'settingsPanel', role: 'dialog', hidden: true,
            'aria-labelledby': 'settingsTitle'
        }, [
            element('div', { className: 'settings-head' }, [
                element('h3', { id: 'settingsTitle', dataset: { i18n: 'settings.title' } }), close
            ]),
            element('span', { className: 'field-label', dataset: { i18n: 'settings.language' } }),
            segmented('language', [['ar', 'lang.ar'], ['en', 'lang.en']], I18n.lang, (value) => I18n.setLang(value)),
            element('span', { className: 'field-label', dataset: { i18n: 'settings.theme' } }),
            segmented('theme', [['system', 'theme.system'], ['light', 'theme.light'], ['dark', 'theme.dark']], theme, (value) => {
                theme = value;
                try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable */ }
                applyTheme();
            }),
            notifyRow,
            notifyHint
        ]);

        function setOpen(open) {
            panel.hidden = !open;
            button.setAttribute('aria-expanded', String(open));
            if (open) panel.querySelector('button.active, input')?.focus();
        }
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            setOpen(panel.hidden);
        });
        close.addEventListener('click', () => setOpen(false));
        document.addEventListener('click', (event) => {
            if (!panel.hidden && !panel.contains(event.target) && event.target !== button) setOpen(false);
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !panel.hidden) {
                setOpen(false);
                button.focus();
            }
        });

        if (api && api.getSettings) {
            api.getSettings().then((settings) => {
                notifyBox.checked = Boolean(settings && settings.blockNotifications);
                if (settings && !settings.notificationsSupported) {
                    notifyBox.disabled = true;
                    notifyHint.dataset.i18n = 'settings.notifUnsupported';
                    notifyHint.textContent = I18n.t('settings.notifUnsupported');
                }
            }).catch(() => {});
            notifyBox.addEventListener('change', () => api.setSettings({ blockNotifications: notifyBox.checked }));
        } else {
            notifyRow.hidden = true;
            notifyHint.hidden = true;
        }

        document.body.append(button, panel);
        I18n.apply(document);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
    else build();

    window.LabShowSettings = { get theme() { return theme; } };
}());
