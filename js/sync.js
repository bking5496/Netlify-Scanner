// ===== OFFLINE SYNC QUEUE =====
// Stores scans that were made offline and need to be synced when back online
const offlineSyncQueue = {
    QUEUE_KEY: 'offlineSyncQueue',

    // Get all pending scans from queue
    getQueue() {
        const queue = localStorage.getItem(this.QUEUE_KEY);
        return queue ? JSON.parse(queue) : [];
    },

    // Add a scan to the offline queue
    addToQueue(scanData) {
        const queue = this.getQueue();
        const queueItem = {
            id: 'offline_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            timestamp: Date.now(),
            data: scanData,
            retryCount: 0
        };
        queue.push(queueItem);
        localStorage.setItem(this.QUEUE_KEY, JSON.stringify(queue));
        console.log('Added scan to offline queue:', queueItem.id);
        return queueItem.id;
    },

    // Remove a scan from the queue (after successful sync)
    removeFromQueue(queueId) {
        const queue = this.getQueue();
        const newQueue = queue.filter(item => item.id !== queueId);
        localStorage.setItem(this.QUEUE_KEY, JSON.stringify(newQueue));
        console.log('Removed scan from offline queue:', queueId);
    },

    // Update retry count for a queued item
    incrementRetry(queueId) {
        const queue = this.getQueue();
        const item = queue.find(i => i.id === queueId);
        if (item) {
            item.retryCount++;
            item.lastRetry = Date.now();
            localStorage.setItem(this.QUEUE_KEY, JSON.stringify(queue));
        }
    },

    // Get count of pending items
    getPendingCount() {
        return this.getQueue().length;
    },

    // Clear the entire queue
    clearQueue() {
        localStorage.removeItem(this.QUEUE_KEY);
    }
};

// Sync all offline scans to Supabase
async function syncOfflineScans() {
    if (!supabase || !navigator.onLine) {
        console.log('Cannot sync - offline or no Supabase');
        return { synced: 0, failed: 0 };
    }

    const queue = offlineSyncQueue.getQueue();
    if (queue.length === 0) {
        console.log('No offline scans to sync');
        return { synced: 0, failed: 0, skippedDuplicates: 0 };
    }

    console.log(`Syncing ${queue.length} offline scans...`);
    let synced = 0;
    let failed = 0;
    let skippedDuplicates = 0;

    for (const item of queue) {
        // Skip items that have failed too many times
        if (item.retryCount >= 5) {
            console.warn('Skipping item with too many retries:', item.id);
            failed++;
            continue;
        }

        try {
            const record = item.data;

            // Check for FP 13-digit duplicates (has pallet_number)
            if (record.session_type === 'FP' && record.pallet_number) {
                // Relies on checkDuplicateInSupabase being globally available (from api.js)
                if (typeof checkDuplicateInSupabase === 'function') {
                    const existingDup = await checkDuplicateInSupabase(
                        record.session_id,
                        record.batch_number,
                        record.pallet_number
                    );
                    if (existingDup) {
                        console.log('Offline scan is duplicate FP pallet, skipping:', item.id, record.batch_number, record.pallet_number);
                        offlineSyncQueue.removeFromQueue(item.id);
                        skippedDuplicates++;
                        continue;
                    }
                }
            }

            const { data, error } = await supabase
                .from('stock_scans')
                .insert([record])
                .select();

            if (error) {
                // Check if this is a unique constraint violation (race condition duplicate)
                // PostgreSQL error code 23505 = unique_violation
                const isDuplicateError = error.code === '23505' ||
                    error.message?.includes('duplicate') ||
                    error.message?.includes('unique constraint');

                if (isDuplicateError && record.session_type === 'FP' && record.pallet_number) {
                    // Another device synced this pallet first - not an error, just skip
                    console.log('Race condition duplicate detected, skipping:', item.id, record.batch_number, record.pallet_number);
                    offlineSyncQueue.removeFromQueue(item.id);
                    skippedDuplicates++;
                } else {
                    console.error('Failed to sync offline scan:', error);
                    offlineSyncQueue.incrementRetry(item.id);
                    failed++;
                }
            } else {
                console.log('Successfully synced offline scan:', item.id);
                offlineSyncQueue.removeFromQueue(item.id);
                synced++;
            }
        } catch (err) {
            console.error('Error syncing offline scan:', err);
            offlineSyncQueue.incrementRetry(item.id);
            failed++;
        }
    }

    console.log(`Offline sync complete: ${synced} synced, ${failed} failed, ${skippedDuplicates} duplicates skipped`);
    return { synced, failed, skippedDuplicates };
}
