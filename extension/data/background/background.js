'use strict';
/**
 * This refers to the webextension background page.
 *  @module BackgroundPage
 */

// Notification stuff

// We store notification meta data here for later use.
const notificationData = {};

/**
 * Generates a UUID. We use this instead of something simpler because Firefox
 * requires notification IDs to be UUIDs.
 * @returns {string}
 */

function uuidv4 () {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
}

/**
 * Sends a native Chrome notification.
 * @param {object} options The notification options
 */
function sendNativeNotification ({title, body, url, modHash, markreadid}) {
    return new Promise((resolve, reject) => {
        if (typeof chrome.notifications.getPermissionLevel === 'undefined') {
            send();
        } else {
            chrome.notifications.getPermissionLevel(permission => {
                if (permission === 'granted') {
                    send();
                } else {
                    reject();
                }
            });
        }

        function send () {
            chrome.notifications.create(uuidv4(), {
                type: 'basic',
                iconUrl: chrome.runtime.getURL('data/images/icon48.png'),
                title,
                message: body,
            }, notificationID => {
                notificationData[notificationID] = {
                    type: 'native',
                    url,
                    modHash,
                    markreadid,
                };
                resolve(notificationID);
            });
        }
    });
}

/**
 * Sends an in-page notification on all open Reddit windows
 * @param {object} options The notification options
 */
function sendPageNotification ({title, body, url, modHash, markreadid}) {
    const notificationID = uuidv4();
    notificationData[notificationID] = {
        type: 'page',
        url,
        modHash,
        markreadid,
    };
    const message = {
        action: 'tb-show-page-notification',
        details: {
            id: notificationID,
            title,
            body,
        },
    };
    return new Promise(resolve => {
        chrome.tabs.query({url: 'https://*.reddit.com/*'}, tabs => {
            for (const tab of tabs) {
                chrome.tabs.sendMessage(tab.id, message);
            }
            resolve(notificationID);
        });
    });
}

/**
 * Clears a notification
 * @param {string} notificationID The ID of the notification
 */
function clearNotification (notificationID) {
    const metadata = notificationData[notificationID];
    if (!metadata) {
        // Notification has already been cleared
        return;
    }
    if (metadata.type === 'native') {
        // Clear a native notification
        chrome.notifications.clear(notificationID);
    } else {
        // Tell all tabs to clear the in-page notification
        const message = {
            action: 'tb-clear-page-notification',
            id: notificationID,
        };
        chrome.tabs.query({url: 'https://*.reddit.com/*'}, tabs => {
            for (const tab of tabs) {
                chrome.tabs.sendMessage(tab.id, message);
            }
        });
        // We don't get a callback when the notifications are closed, so we just
        // clean up the data here
        delete notificationData[notificationID];
    }
}

/**
 * Handles a click on a notification
 * @param {string} notificationID The ID of the notification
 */
function onClickNotification (notificationID) {
    // Store the metadata so we can work with it after clearing the notification
    const metadata = notificationData[notificationID];
    console.log('notification clikcked: ', metadata);

    // Mark as read if needed.
    if (notificationData[notificationID].markreadid) {
        $.post('https://old.reddit.com/api/read_message', {
            id: metadata.markreadid,
            uh: metadata.modHash,
            api_type: 'json',
        });
    }

    // Open up in new tab.
    chrome.windows.getLastFocused(window => {
        chrome.tabs.create({
            url: metadata.url,
            windowId: window.id,
        });
    });

    // Notification no longer needed, clear it.
    clearNotification(notificationID);
}

// Handle events on native notifications
chrome.notifications.onClicked.addListener(onClickNotification);
chrome.notifications.onClosed.addListener(id => {
    // Now that the notification is closed, we're done with its metadata
    delete notificationData[id];
});

//
// Cache handling.
//

let TBsettingsObject = {};
const cachedata = {
    timeouts: {},
    currentDurations: {
        long: 0,
        short: 0,
    },
};

/**
 * emptyshort or long cache if it expires
 * @param timeoutDuration Timeout value in minutes
 * @param cacheType The type of cache, either `short` or `long`
 */

function emptyCacheTimeout (timeoutDuration, cacheType) {
    // Make sure we always clear any running timeouts so we don't get things running multiple times.
    clearTimeout(cachedata.timeouts[cacheType]);

    // Users fill in the value in minutes, we need milliseconds of course.
    const timeoutMS = timeoutDuration * 60 * 1000;

    console.log('clearing cache:', cacheType, timeoutMS);
    if (cacheType === 'short') {
        localStorage['TBCache.Utils.noteCache'] = '{}';
        localStorage['TBCache.Utils.noConfig'] = '[]';
        localStorage['TBCache.Utils.noNotes'] = '[]';
    }

    if (cacheType === 'long') {
        localStorage['TBCache.Utils.configCache'] = '{}';
        localStorage['TBCache.Utils.rulesCache'] = '{}';
        localStorage['TBCache.Utils.noRules'] = '[]';
        localStorage['TBCache.Utils.moderatedSubs'] = '[]';
        localStorage['TBCache.Utils.moderatedSubsData'] = '[]';
    }

    // Let's make sure all our open tabs know that cache has been cleared for these types.
    chrome.tabs.query({}, tabs => {
        for (let i = 0; i < tabs.length; ++i) {
            if (tabs[i].url.includes('reddit.com')) {
                chrome.tabs.sendMessage(tabs[i].id, {
                    action: 'tb-cache-timeout',
                    payload: cacheType,
                });
            }
        }
    });

    // Done, go for another round.
    cachedata.timeouts[cacheType] = setTimeout(() => {
        emptyCacheTimeout(timeoutDuration, cacheType);
    }, timeoutMS);
}

/**
 * Initiates cache timeouts based on toolbox settings.
 * @param {Boolean} forceRefresh when true will clear both caches and start fresh.
 */
function initCachetimeout (forceRefresh) {
    console.log(TBsettingsObject);
    console.log('Caching timeout initiated');
    const storageShortLengthKey = 'Toolbox.Utils.shortLength';
    const storageLongLengthKey = 'Toolbox.Utils.longLength';
    let storageShortLength;
    let storageLongLength;

    // Get current shortLength value from storage.
    if (TBsettingsObject.tbsettings[storageShortLengthKey] === undefined) {
        storageShortLength = 15;
    } else {
        storageShortLength = TBsettingsObject.tbsettings[storageShortLengthKey];

        if (typeof storageShortLength !== 'number') {
            storageShortLength = parseInt(storageShortLength);
        }
    }

    // Compare the current timeout value to the one in storage. Reinit timeout when needed.
    if (storageShortLength !== cachedata.currentDurations.short || forceRefresh) {
        console.log('Short timeout', storageShortLength);
        cachedata.currentDurations.short = storageShortLength;
        emptyCacheTimeout(storageShortLength, 'short');
    }

    // Get current longLength value from storage.
    if (TBsettingsObject.tbsettings[storageLongLengthKey] === undefined) {
        storageLongLength = 45;
    } else {
        storageLongLength = TBsettingsObject.tbsettings[storageLongLengthKey];
        if (typeof storageLongLength !== 'number') {
            storageLongLength = parseInt(storageLongLength);
        }
    }

    // Compare the current timeout value to the one in storage. Reinit timeout when needed.
    if (storageLongLength !== cachedata.currentDurations.long || forceRefresh) {
        console.log('Long timeout', storageLongLength);
        cachedata.currentDurations.short = storageShortLength;
        emptyCacheTimeout(storageLongLength, 'long');
    }
}

chrome.storage.local.get('tbsettings', sObject => {
    console.log('first cache init');
    TBsettingsObject = sObject;
    initCachetimeout(true);
});

//
// Webextension messaging handling.
//
const messageHandlers = new Map();
browser.runtime.onMessage.addListener((request, sender) => {
    const handler = messageHandlers.get(request.action);
    if (handler) {
        return Promise.resolve(handler(request, sender));
    // } else {
    //     console.log('Unknown message type:', request, sender);
    }

    if (request.action === 'tb-global') {
        const message = {
            action: request.globalEvent,
            payload: request.payload,
        };

        chrome.tabs.query({}, tabs => {
            for (let i = 0; i < tabs.length; ++i) {
                if (sender.tab.id !== tabs[i].id && tabs[i].url.includes('reddit.com')) {
                    chrome.tabs.sendMessage(tabs[i].id, message);
                }
            }
        });

        // The settings update global event also needs to be handled in the background.
        if (request.globalEvent === 'tb-settings-update') {
            TBsettingsObject = request.payload;
            initCachetimeout();
        }
    }

    if (request.action === 'tb-cache-force-timeout') {
        initCachetimeout(true);
        return; // no response needed
    }

    if (request.action === 'tb-notification') {
        const notificationTimeout = 6000;
        const sendNotification = request.native ? sendNativeNotification : sendPageNotification;
        sendNotification(request.details).then(id => {
            setTimeout(() => {
                clearNotification(id);
            }, notificationTimeout);
        });
        return; // no response needed
    }

    if (request.action === 'tb-page-notification-click') {
        onClickNotification(request.id);
        return; // no response needed
    }

    if (request.action === 'tb-page-notification-close') {
        clearNotification(request.id);
        return; // no response needed
    }

    if (request.action === 'tb-cache') {
        const {method, storageKey, inputValue} = request;

        if (method === 'get') {
            const result = {};
            if (localStorage[storageKey] === undefined) {
                result.value = inputValue;
            } else {
                const storageString = localStorage[storageKey];
                try {
                    result.value = JSON.parse(storageString);
                } catch (error) { // if everything gets strignified, it's always JSON.  If this happens, the storage val is corrupted.
                    result.errorThrown = error.toString();
                    result.value = inputValue;
                }

                // send back the default if, somehow, someone stored `null`
                // NOTE: never, EVER store `null`!
                if (result.value === null && inputValue !== null) {
                    result.value = inputValue;
                }
            }

            return Promise.resolve(result);
        }

        if (method === 'set') {
            localStorage[storageKey] = JSON.stringify(inputValue);
            return;
        }

        if (method === 'clear') {
            localStorage.clear();
            return;
        }
    }
});
