// The visual viewport excludes the mobile keyboard and browser chrome.
// Keep pinch zoom available; only size/position the overlay to the visible area.
(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let frame;
    function update() {
        frame = undefined;
        root.style.setProperty('--view-height', (viewport?.height || window.innerHeight) + 'px');
        root.style.setProperty('--view-width', (viewport?.width || window.innerWidth) + 'px');
        root.style.setProperty('--view-top', (viewport?.offsetTop || 0) + 'px');
        root.style.setProperty('--view-left', (viewport?.offsetLeft || 0) + 'px');
    }
    function schedule() {
        if (frame === undefined) frame = requestAnimationFrame(update);
    }
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('pageshow', schedule);
    update();
})();
