// screen-adapter.js — automatic screen size detection and adaptive layout for desktop.
// It measures the available viewport and adjusts button sizes, text sizes, and
// page/card dimensions so the app fits the user's screen naturally.

(function () {
    'use strict';

    const MIN_BUTTON_SIZE = 30;   // px
    const MAX_BUTTON_SIZE = 52;   // px
    const MIN_TEXT_SIZE = 13;     // px
    const MAX_TEXT_SIZE = 20;     // px

    let adaptTimer = null;

    function detectAndAdapt() {
        if (adaptTimer) clearTimeout(adaptTimer);
        adaptTimer = setTimeout(() => {
            applyAdaptiveSizes();
        }, 50);
    }

    function viewportSize() {
        return {
            width: window.innerWidth,
            height: window.innerHeight
        };
    }

    // Returns the optimal scale factor for buttons (0.8 to 1.2).
    function computeScale() {
        const { width, height } = viewportSize();
        // Desktop: 1920x1080 and up get max scaling, smaller screens get proportionally less
        const wide = Math.min(width, height); // screen size for diagonal estimate
        if (wide >= 1900) return 1.0;           // Full HD or higher
        if (wide >= 1500) return 0.9;
        if (wide >= 1200) return 0.8;
        if (wide >= 800) return 0.7;
        return 0.6;
    }

    function applyAdaptiveSizes() {
        const scale = computeScale();
        const buttonSize = Math.round(MIN_BUTTON_SIZE + (MAX_BUTTON_SIZE - MIN_BUTTON_SIZE) * scale);
        const textSize = Math.round(MIN_TEXT_SIZE + (MAX_TEXT_SIZE - MIN_TEXT_SIZE) * scale);

        const root = document.documentElement;
        root.style.setProperty('--btn-height', `${Math.min(buttonSize, 48)}px`);
        root.style.setProperty('--btn-font-size', `${Math.min(textSize, 20)}px`);
        root.style.setProperty('--btn-padding', `${Math.round(buttonSize * 0.7)}px`);

        // Adjust card padding based on screen
        const pad = Math.max(12, Math.min(24, Math.round(viewportSize().width * 0.015)));
        root.style.setProperty('--pad', `${pad}px`);

        // Add a class for desktop layout
        const isDesktop = window.matchMedia('(min-width: 768px)').matches;
        document.body.classList.toggle('is-desktop', isDesktop);
        document.body.classList.toggle('is-mobile', !isDesktop);
    }

    // Monitor viewport changes
    window.addEventListener('resize', detectAndAdapt);
    window.addEventListener('orientationchange', detectAndAdapt);

    // Run on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyAdaptiveSizes);
    } else {
        applyAdaptiveSizes();
    }

    window.LabShowScreenAdapter = {
        detectAndAdapt,
        applyAdaptiveSizes,
        viewportSize,
        computeScale
    };
})();
