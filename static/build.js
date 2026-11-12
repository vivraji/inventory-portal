// Report the packaged server build without delaying inventory initialization.
(async () => {
    const badge = document.getElementById('buildInfo');
    if (!badge) return;
    try {
        const response = await fetch('/api/build', {cache:'no-store',signal:AbortSignal.timeout(10000)});
        if (!response.ok) throw Error('Build unavailable');
        const build = await response.json();
        if (!Number.isSafeInteger(build.build_number) || build.build_number < 1) throw Error('Invalid build');
        badge.textContent = 'Build '+build.build_number+' · Release notes';
    } catch {
        badge.textContent = 'Build unavailable · Release notes';
    }
})();
