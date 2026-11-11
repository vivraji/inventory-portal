/* One stream per page; EventSource owns automatic reconnection. */
function createInventorySync(readInventory, report = () => {}) {
    let source, timer, running, dirty = false, stopped = true;
    function schedule(delay = 100) {
        clearTimeout(timer);
        if (!stopped) timer = setTimeout(() => {
            timer = undefined;
            refresh();
        }, delay);
    }
    function refresh() {
        if (stopped) return Promise.resolve();
        dirty = true;
        if (running) return running;
        running = (async () => {
            try {
                while (dirty && !stopped) {
                    dirty = false;
                    await readInventory();
                    report(source?.readyState === 1 ? 'Live updates connected' :
                        'Inventory refreshed. Waiting for live updates.');
                }
            } catch (error) {
                report('Refresh failed. Retrying…');
                schedule(3000);
            } finally {
                running = undefined;
            }
        })();
        return running;
    }
    function connect() {
        if (source || stopped) return;
        if (!('EventSource' in window)) {
            report('Live updates unavailable. Refreshing when you return.');
            return;
        }
        source = new EventSource('/api/events');
        source.addEventListener('inventory', () => schedule());
        source.onopen = () => {
            report('Live updates connected');
            schedule();
        };
        source.onerror = () => report('Live updates disconnected. Reconnecting…');
    }
    function resume() {
        if (document.visibilityState === 'hidden') return;
        connect();
        schedule();
    }
    function pageShow() {
        stopped = false;
        resume();
    }
    function pause() {
        stopped = true;
        clearTimeout(timer);
        timer = undefined;
        source?.close();
        source = undefined;
    }
    return {
        refresh,
        start() {
            stopped = false;
            window.addEventListener('focus', resume);
            document.addEventListener('visibilitychange', resume);
            window.addEventListener('online', resume);
            window.addEventListener('pagehide', pause);
            window.addEventListener('pageshow', pageShow);
            connect();
            refresh();
        },
        stop() {
            pause();
            window.removeEventListener('focus', resume);
            document.removeEventListener('visibilitychange', resume);
            window.removeEventListener('online', resume);
            window.removeEventListener('pagehide', pause);
            window.removeEventListener('pageshow', pageShow);
        }
    };
}
