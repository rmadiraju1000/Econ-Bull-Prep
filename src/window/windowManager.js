// DevTools windows are opt-in: run `GLASS_DEVTOOLS=1 npm start` to open them.
const SHOW_DEVTOOLS = process.env.GLASS_DEVTOOLS === '1';
const { BrowserWindow, globalShortcut, screen, app, shell } = require('electron');
const WindowLayoutManager = require('./windowLayoutManager');
const SmoothMovementManager = require('./smoothMovementManager');
const path = require('node:path');
const os = require('os');
const shortcutsService = require('../features/shortcuts/shortcutsService');
const internalBridge = require('../bridge/internalBridge');
const permissionRepository = require('../features/common/repositories/permission');

/* ────────────────[ GLASS BYPASS ]─────────────── */
let liquidGlass;
const isLiquidGlassSupported = () => {
    if (process.platform !== 'darwin') {
        return false;
    }
    const majorVersion = parseInt(os.release().split('.')[0], 10);
    // return majorVersion >= 25; // macOS 26+ (Darwin 25+)
    return majorVersion >= 26; // See you soon!
};
let shouldUseLiquidGlass = isLiquidGlassSupported();
if (shouldUseLiquidGlass) {
    try {
        liquidGlass = require('electron-liquid-glass');
    } catch (e) {
        console.warn('Could not load optional dependency "electron-liquid-glass". The feature will be disabled.');
        shouldUseLiquidGlass = false;
    }
}
/* ────────────────[ GLASS BYPASS ]─────────────── */

let isContentProtectionOn = true;
let lastVisibleWindows = new Set(['header']);

let currentHeaderState = 'apikey';
const windowPool = new Map();

let settingsHideTimer = null;


let layoutManager = null;
let movementManager = null;

// ── Windows you move or resize yourself stay where you put them ──────────────
// { listen: { bounds, sized }, ask: { bounds, sized } } — saved between launches.
const fs = require('node:fs');
const PLACEMENT_FILE = () => path.join(app.getPath('userData'), 'window-placement.json');
let userPlaced = {};
try {
    userPlaced = JSON.parse(fs.readFileSync(PLACEMENT_FILE(), 'utf8')) || {};
} catch (_) {
    userPlaced = {};
}
let savePlacementTimer = null;
function savePlacement() {
    clearTimeout(savePlacementTimer);
    savePlacementTimer = setTimeout(() => {
        try {
            fs.writeFileSync(PLACEMENT_FILE(), JSON.stringify(userPlaced));
        } catch (e) {
            console.warn('[WindowManager] Could not save window placement:', e.message);
        }
    }, 300);
}
function sendUserSized(name) {
    const win = windowPool.get(name);
    if (win && !win.isDestroyed()) win.webContents.send('window:user-sized', !!userPlaced[name]?.sized);
}
/** Keep a saved position on a screen that still exists (monitor unplugged, resolution changed). */
function clampToScreen(bounds) {
    const display = screen.getDisplayMatching(bounds);
    const wa = display.workArea;
    const width = Math.min(bounds.width, wa.width);
    const height = Math.min(bounds.height, wa.height);
    const x = Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - width));
    const y = Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - height));
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
function trackUserPlacement(name, win) {
    let userAction = null;
    win.on('will-move', () => {
        if (!movementManager?.isAnimating) userAction = userAction || 'move';
    });
    win.on('will-resize', () => {
        userAction = 'resize';
    });
    const commit = () => {
        if (!userAction) return;
        const sized = userAction === 'resize' || !!userPlaced[name]?.sized;
        userAction = null;
        userPlaced[name] = { bounds: win.getBounds(), sized };
        console.log(`[WindowManager] You placed '${name}' at ${JSON.stringify(userPlaced[name].bounds)}${sized ? ' (custom size)' : ''}`);
        savePlacement();
        sendUserSized(name);
    };
    win.on('moved', commit);
    win.on('resized', commit);
    win.webContents.on('did-finish-load', () => sendUserSized(name));
}
const resetWindowPlacement = (name) => {
    if (!userPlaced[name]) return;
    delete userPlaced[name];
    savePlacement();
    sendUserSized(name);
    console.log(`[WindowManager] '${name}' snapped back next to the header`);
    updateChildWindowLayouts(true);
};


function updateChildWindowLayouts(animated = true) {
    // if (movementManager.isAnimating) return;

    const visibleWindows = {};
    const listenWin = windowPool.get('listen');
    const askWin = windowPool.get('ask');
    if (listenWin && !listenWin.isDestroyed() && listenWin.isVisible() && !userPlaced.listen) {
        visibleWindows.listen = true;
    }
    if (askWin && !askWin.isDestroyed() && askWin.isVisible() && !userPlaced.ask) {
        visibleWindows.ask = true;
    }

    if (Object.keys(visibleWindows).length === 0) return;

    const newLayout = layoutManager.calculateFeatureWindowLayout(visibleWindows);
    movementManager.animateLayout(newLayout, animated);
}

const showSettingsWindow = () => {
    internalBridge.emit('window:requestVisibility', { name: 'settings', visible: true });
};

const hideSettingsWindow = () => {
    internalBridge.emit('window:requestVisibility', { name: 'settings', visible: false });
};

const cancelHideSettingsWindow = () => {
    internalBridge.emit('window:requestVisibility', { name: 'settings', visible: true });
};

const moveWindowStep = (direction) => {
    internalBridge.emit('window:moveStep', { direction });
};

const resizeHeaderWindow = ({ width, height }) => {
    internalBridge.emit('window:resizeHeaderWindow', { width, height });
};

const handleHeaderAnimationFinished = (state) => {
    internalBridge.emit('window:headerAnimationFinished', state);
};

const getHeaderPosition = () => {
    return new Promise((resolve) => {
        internalBridge.emit('window:getHeaderPosition', (position) => {
            resolve(position);
        });
    });
};

const moveHeaderTo = (newX, newY) => {
    internalBridge.emit('window:moveHeaderTo', { newX, newY });
};

const adjustWindowHeight = (winName, targetHeight) => {
    internalBridge.emit('window:adjustWindowHeight', { winName, targetHeight });
};


function setupWindowController(windowPool, layoutManager, movementManager) {
    internalBridge.on('window:requestVisibility', ({ name, visible }) => {
        handleWindowVisibilityRequest(windowPool, layoutManager, movementManager, name, visible);
    });
    internalBridge.on('window:requestToggleAllWindowsVisibility', ({ targetVisibility }) => {
        changeAllWindowsVisibility(windowPool, targetVisibility);
    });
    internalBridge.on('window:moveToDisplay', ({ displayId }) => {
        // movementManager.moveToDisplay(displayId);
        const header = windowPool.get('header');
        if (header) {
            const newPosition = layoutManager.calculateNewPositionForDisplay(header, displayId);
            if (newPosition) {
                movementManager.animateWindowPosition(header, newPosition, {
                    onComplete: () => updateChildWindowLayouts(true)
                });
            }
        }
    });
    internalBridge.on('window:moveToEdge', ({ direction }) => {
        const header = windowPool.get('header');
        if (header) {
            const newPosition = layoutManager.calculateEdgePosition(header, direction);
            movementManager.animateWindowPosition(header, newPosition, { 
                onComplete: () => updateChildWindowLayouts(true) 
            });
        }
    });

    internalBridge.on('window:moveStep', ({ direction }) => {
        const header = windowPool.get('header');
        if (header) { 
            const newHeaderPosition = layoutManager.calculateStepMovePosition(header, direction);
            if (!newHeaderPosition) return;
    
            const futureHeaderBounds = { ...header.getBounds(), ...newHeaderPosition };
            const visibleWindows = {};
            const listenWin = windowPool.get('listen');
            const askWin = windowPool.get('ask');
            if (listenWin && !listenWin.isDestroyed() && listenWin.isVisible() && !userPlaced.listen) {
                visibleWindows.listen = true;
            }
            if (askWin && !askWin.isDestroyed() && askWin.isVisible() && !userPlaced.ask) {
                visibleWindows.ask = true;
            }

            const newChildLayout = layoutManager.calculateFeatureWindowLayout(visibleWindows, futureHeaderBounds);
    
            movementManager.animateWindowPosition(header, newHeaderPosition);
            movementManager.animateLayout(newChildLayout);
        }
    });

    internalBridge.on('window:resizeHeaderWindow', ({ width, height }) => {
        const header = windowPool.get('header');
        if (!header || movementManager.isAnimating) return;

        const newHeaderBounds = layoutManager.calculateHeaderResize(header, { width, height });
        
        const wasResizable = header.isResizable();
        if (!wasResizable) header.setResizable(true);

        movementManager.animateWindowBounds(header, newHeaderBounds, {
            onComplete: () => {
                if (!wasResizable) header.setResizable(false);
                updateChildWindowLayouts(true);
            }
        });
    });
    internalBridge.on('window:headerAnimationFinished', (state) => {
        const header = windowPool.get('header');
        if (!header || header.isDestroyed()) return;

        if (state === 'hidden') {
            header.hide();
        } else if (state === 'visible') {
            updateChildWindowLayouts(false);
        }
    });
    internalBridge.on('window:getHeaderPosition', (reply) => {
        const header = windowPool.get('header');
        if (header && !header.isDestroyed()) {
            reply(header.getBounds());
        } else {
            reply({ x: 0, y: 0, width: 0, height: 0 });
        }
    });
    internalBridge.on('window:moveHeaderTo', ({ newX, newY }) => {
        const header = windowPool.get('header');
        if (header) {
            const newPosition = layoutManager.calculateClampedPosition(header, { x: newX, y: newY });
            header.setPosition(newPosition.x, newPosition.y);
        }
    });
    internalBridge.on('window:adjustWindowHeight', ({ winName, targetHeight }) => {
        const senderWindow = windowPool.get(winName);
        if (!senderWindow || senderWindow.isDestroyed()) return;
        if (userPlaced[winName]?.sized) return; // you picked the size; the content scrolls inside it
        const current = senderWindow.getBounds();
        const newBounds = layoutManager.calculateWindowHeightAdjustment(senderWindow, targetHeight);
        if (!newBounds || Math.abs(newBounds.height - current.height) < 4) return; // nothing to do (was firing thousands of times)
        // Grow/shrink instantly instead of animating, so it never fights a drag.
        senderWindow.setBounds(userPlaced[winName] ? clampToScreen(newBounds) : newBounds);
        if (userPlaced[winName]) {
            userPlaced[winName].bounds = senderWindow.getBounds();
            savePlacement();
        } else {
            updateChildWindowLayouts(false);
        }
    });
}

function changeAllWindowsVisibility(windowPool, targetVisibility) {
    const header = windowPool.get('header');
    if (!header) return;

    if (typeof targetVisibility === 'boolean' &&
        header.isVisible() === targetVisibility) {
        return;
    }
  
    if (header.isVisible()) {
      lastVisibleWindows.clear();
  
      windowPool.forEach((win, name) => {
        if (win && !win.isDestroyed() && win.isVisible()) {
          lastVisibleWindows.add(name);
        }
      });
  
      lastVisibleWindows.forEach(name => {
        if (name === 'header') return;
        const win = windowPool.get(name);
        if (win && !win.isDestroyed()) win.hide();
      });
      header.hide();
  
      return;
    }
  
    lastVisibleWindows.forEach(name => {
      const win = windowPool.get(name);
      if (win && !win.isDestroyed())
        win.show();
    });
  }

/**
 * 
 * @param {Map<string, BrowserWindow>} windowPool
 * @param {WindowLayoutManager} layoutManager 
 * @param {SmoothMovementManager} movementManager
 * @param {'listen' | 'ask' | 'settings' | 'shortcut-settings'} name 
 * @param {boolean} shouldBeVisible 
 */
async function handleWindowVisibilityRequest(windowPool, layoutManager, movementManager, name, shouldBeVisible) {
    console.log(`[WindowManager] Request: set '${name}' visibility to ${shouldBeVisible}`);
    const win = windowPool.get(name);

    if (!win || win.isDestroyed()) {
        console.warn(`[WindowManager] Window '${name}' not found or destroyed.`);
        return;
    }

    if (name !== 'settings') {
        const isCurrentlyVisible = win.isVisible();
        if (isCurrentlyVisible === shouldBeVisible) {
            console.log(`[WindowManager] Window '${name}' is already in the desired state.`);
            return;
        }
    }

    const disableClicks = (selectedWindow) => {
        for (const [name, win] of windowPool) {
            if (win !== selectedWindow && !win.isDestroyed()) {
                win.setIgnoreMouseEvents(true, { forward: true });
            }
        }
    };

    const restoreClicks = () => {
        for (const [, win] of windowPool) {
            if (!win.isDestroyed()) win.setIgnoreMouseEvents(false);
        }
    };

    if (name === 'settings') {
        if (shouldBeVisible) {
            // Cancel any pending hide operations
            if (settingsHideTimer) {
                clearTimeout(settingsHideTimer);
                settingsHideTimer = null;
            }
            const position = layoutManager.calculateSettingsWindowPosition();
            if (position) {
                win.setBounds(position);
                win.__lockedByButton = true;
                win.show();
                win.moveTop();
                win.setAlwaysOnTop(true);
            } else {
                console.warn('[WindowManager] Could not calculate settings window position.');
            }
        } else {
            // Hide after a delay
            if (settingsHideTimer) {
                clearTimeout(settingsHideTimer);
            }
            settingsHideTimer = setTimeout(() => {
                if (win && !win.isDestroyed()) {
                    win.setAlwaysOnTop(false);
                    win.hide();
                }
                settingsHideTimer = null;
            }, 200);

            win.__lockedByButton = false;
        }
        return;
    }


    if (name === 'shortcut-settings') {
        if (shouldBeVisible) {
            // layoutManager.positionShortcutSettingsWindow();
            const newBounds = layoutManager.calculateShortcutSettingsWindowPosition();
            if (newBounds) win.setBounds(newBounds);
            
            if (process.platform === 'darwin') {
                win.setAlwaysOnTop(true, 'screen-saver');
            } else {
                win.setAlwaysOnTop(true);
            }
            // globalShortcut.unregisterAll();
            disableClicks(win);
            win.show();
        } else {
            if (process.platform === 'darwin') {
                win.setAlwaysOnTop(false, 'screen-saver');
            } else {
                win.setAlwaysOnTop(false);
            }
            restoreClicks();
            win.hide();
        }
        return;
    }

    if (name === 'listen' || name === 'ask') {
        const win = windowPool.get(name);
        const otherName = name === 'listen' ? 'ask' : 'listen';
        const otherWin = windowPool.get(otherName);
        const isOtherWinVisible = otherWin && !otherWin.isDestroyed() && otherWin.isVisible();
        
        const ANIM_OFFSET_X = 50;
        const ANIM_OFFSET_Y = 20;

        const finalVisibility = {
            listen: (name === 'listen' && shouldBeVisible) || (otherName === 'listen' && isOtherWinVisible),
            ask: (name === 'ask' && shouldBeVisible) || (otherName === 'ask' && isOtherWinVisible),
        };
        if (!shouldBeVisible) {
            finalVisibility[name] = false;
        }

        // Windows you placed yourself are not part of the automatic layout.
        if (userPlaced.listen) finalVisibility.listen = false;
        if (userPlaced.ask) finalVisibility.ask = false;
        const targetLayout = layoutManager.calculateFeatureWindowLayout(finalVisibility);

        if (shouldBeVisible && userPlaced[name]) {
            if (!win) return;
            win.setOpacity(0);
            win.setBounds(clampToScreen(userPlaced[name].bounds));
            win.show();
            movementManager.fade(win, { to: 1 });
            movementManager.animateLayout(targetLayout);
            sendUserSized(name);
            return;
        }

        if (shouldBeVisible) {
            if (!win) return;
            const targetBounds = targetLayout[name];
            if (!targetBounds) return;

            const startPos = { ...targetBounds };
            if (name === 'listen') startPos.x -= ANIM_OFFSET_X;
            else if (name === 'ask') startPos.y -= ANIM_OFFSET_Y;

            win.setOpacity(0);
            win.setBounds(startPos);
            win.show();

            movementManager.fade(win, { to: 1 });
            movementManager.animateLayout(targetLayout);

        } else {
            if (!win || !win.isVisible()) return;

            const currentBounds = win.getBounds();
            const targetPos = { ...currentBounds };
            if (name === 'listen') targetPos.x -= ANIM_OFFSET_X;
            else if (name === 'ask') targetPos.y -= ANIM_OFFSET_Y;

            movementManager.fade(win, { to: 0, onComplete: () => win.hide() });
            if (!userPlaced[name]) movementManager.animateWindowPosition(win, targetPos);
            
            // 다른 창들도 새 레이아웃으로 애니메이션
            const otherWindowsLayout = { ...targetLayout };
            delete otherWindowsLayout[name];
            movementManager.animateLayout(otherWindowsLayout);
        }
    }
}


const setContentProtection = (status) => {
    isContentProtectionOn = status;
    console.log(`[Protection] Content protection toggled to: ${isContentProtectionOn}`);
    windowPool.forEach(win => {
        if (win && !win.isDestroyed()) {
            win.setContentProtection(isContentProtectionOn);
        }
    });
};

const getContentProtectionStatus = () => isContentProtectionOn;

const toggleContentProtection = () => {
    const newStatus = !getContentProtectionStatus();
    setContentProtection(newStatus);
    return newStatus;
};


const openLoginPage = () => {
    const webUrl = process.env.pickleglass_WEB_URL || 'http://localhost:3000';
    const personalizeUrl = `${webUrl}/personalize?desktop=true`;
    shell.openExternal(personalizeUrl);
    console.log('Opening personalization page:', personalizeUrl);
};


function createFeatureWindows(header, namesToCreate) {
    // if (windowPool.has('listen')) return;

    const commonChildOptions = {
        parent: header,
        maximizable: false, // double-clicking the drag bar shouldn't blow the window up to full screen
        fullscreenable: false,
        show: false,
        frame: false,
        transparent: true,
        vibrancy: false,
        hasShadow: false,
        skipTaskbar: true,
        hiddenInMissionControl: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../preload.js'),
        },
    };

    const createFeatureWindow = (name) => {
        if (windowPool.has(name)) return;
        
        switch (name) {
            case 'listen': {
                const listen = new BrowserWindow({
                    ...commonChildOptions, width:400, minWidth:300, maxWidth:1200,
                    minHeight:120, maxHeight:1400, resizable:true,
                });
                trackUserPlacement('listen', listen);
                listen.setContentProtection(isContentProtectionOn);
                listen.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
                if (process.platform === 'darwin') {
                    listen.setWindowButtonVisibility(false);
                }
                const listenLoadOptions = { query: { view: 'listen' } };
                if (!shouldUseLiquidGlass) {
                    listen.loadFile(path.join(__dirname, '../ui/app/content.html'), listenLoadOptions);
                }
                else {
                    listenLoadOptions.query.glass = 'true';
                    listen.loadFile(path.join(__dirname, '../ui/app/content.html'), listenLoadOptions);
                    listen.webContents.once('did-finish-load', () => {
                        const viewId = liquidGlass.addView(listen.getNativeWindowHandle());
                        if (viewId !== -1) {
                            liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                            // liquidGlass.unstable_setScrim(viewId, 1);
                            // liquidGlass.unstable_setSubdued(viewId, 1);
                        }
                    });
                }
                if (SHOW_DEVTOOLS) {
                    listen.webContents.openDevTools({ mode: 'detach' });
                }
                windowPool.set('listen', listen);
                break;
            }

            // ask
            case 'ask': {
                const ask = new BrowserWindow({ ...commonChildOptions, width:600, minWidth:320, minHeight:80, maxHeight:1400, resizable:true });
                trackUserPlacement('ask', ask);
                ask.setContentProtection(isContentProtectionOn);
                ask.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
                if (process.platform === 'darwin') {
                    ask.setWindowButtonVisibility(false);
                }
                const askLoadOptions = { query: { view: 'ask' } };
                if (!shouldUseLiquidGlass) {
                    ask.loadFile(path.join(__dirname, '../ui/app/content.html'), askLoadOptions);
                }
                else {
                    askLoadOptions.query.glass = 'true';
                    ask.loadFile(path.join(__dirname, '../ui/app/content.html'), askLoadOptions);
                    ask.webContents.once('did-finish-load', () => {
                        const viewId = liquidGlass.addView(ask.getNativeWindowHandle());
                        if (viewId !== -1) {
                            liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                            // liquidGlass.unstable_setScrim(viewId, 1);
                            // liquidGlass.unstable_setSubdued(viewId, 1);
                        }
                    });
                }
                
                // Open DevTools in development
                if (SHOW_DEVTOOLS) {
                    ask.webContents.openDevTools({ mode: 'detach' });
                }
                windowPool.set('ask', ask);
                break;
            }

            // settings
            case 'settings': {
                const settings = new BrowserWindow({ ...commonChildOptions, width:240, maxHeight:400, parent:undefined });
                settings.setContentProtection(isContentProtectionOn);
                settings.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
                if (process.platform === 'darwin') {
                    settings.setWindowButtonVisibility(false);
                }
                const settingsLoadOptions = { query: { view: 'settings' } };
                if (!shouldUseLiquidGlass) {
                    settings.loadFile(path.join(__dirname,'../ui/app/content.html'), settingsLoadOptions)
                        .catch(console.error);
                }
                else {
                    settingsLoadOptions.query.glass = 'true';
                    settings.loadFile(path.join(__dirname,'../ui/app/content.html'), settingsLoadOptions)
                        .catch(console.error);
                    settings.webContents.once('did-finish-load', () => {
                        const viewId = liquidGlass.addView(settings.getNativeWindowHandle());
                        if (viewId !== -1) {
                            liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                            // liquidGlass.unstable_setScrim(viewId, 1);
                            // liquidGlass.unstable_setSubdued(viewId, 1);
                        }
                    });
                }
                windowPool.set('settings', settings);  

                if (SHOW_DEVTOOLS) {
                    settings.webContents.openDevTools({ mode: 'detach' });
                }
                break;
            }

            case 'shortcut-settings': {
                const shortcutEditor = new BrowserWindow({
                    ...commonChildOptions,
                    width: 353,
                    height: 720,
                    modal: false,
                    parent: undefined,
                    alwaysOnTop: true,
                    titleBarOverlay: false,
                });

                shortcutEditor.setContentProtection(isContentProtectionOn);
                shortcutEditor.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
                if (process.platform === 'darwin') {
                    shortcutEditor.setWindowButtonVisibility(false);
                }

                const loadOptions = { query: { view: 'shortcut-settings' } };
                if (!shouldUseLiquidGlass) {
                    shortcutEditor.loadFile(path.join(__dirname, '../ui/app/content.html'), loadOptions);
                } else {
                    loadOptions.query.glass = 'true';
                    shortcutEditor.loadFile(path.join(__dirname, '../ui/app/content.html'), loadOptions);
                    shortcutEditor.webContents.once('did-finish-load', () => {
                        const viewId = liquidGlass.addView(shortcutEditor.getNativeWindowHandle());
                        if (viewId !== -1) {
                            liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                        }
                    });
                }

                windowPool.set('shortcut-settings', shortcutEditor);
                if (SHOW_DEVTOOLS) {
                    shortcutEditor.webContents.openDevTools({ mode: 'detach' });
                }
                break;
            }
        }
    };

    if (Array.isArray(namesToCreate)) {
        namesToCreate.forEach(name => createFeatureWindow(name));
    } else if (typeof namesToCreate === 'string') {
        createFeatureWindow(namesToCreate);
    } else {
        createFeatureWindow('listen');
        createFeatureWindow('ask');
        createFeatureWindow('settings');
        createFeatureWindow('shortcut-settings');
    }
}

function destroyFeatureWindows() {
    const featureWindows = ['listen','ask','settings','shortcut-settings'];
    if (settingsHideTimer) {
        clearTimeout(settingsHideTimer);
        settingsHideTimer = null;
    }
    featureWindows.forEach(name=>{
        const win = windowPool.get(name);
        if (win && !win.isDestroyed()) win.destroy();
        windowPool.delete(name);
    });
}



function getCurrentDisplay(window) {
    if (!window || window.isDestroyed()) return screen.getPrimaryDisplay();

    const windowBounds = window.getBounds();
    const windowCenter = {
        x: windowBounds.x + windowBounds.width / 2,
        y: windowBounds.y + windowBounds.height / 2,
    };

    return screen.getDisplayNearestPoint(windowCenter);
}



function createWindows() {
    const HEADER_HEIGHT        = 47;
    const DEFAULT_WINDOW_WIDTH = 353;

    const primaryDisplay = screen.getPrimaryDisplay();
    const { y: workAreaY, width: screenWidth } = primaryDisplay.workArea;

    const initialX = Math.round((screenWidth - DEFAULT_WINDOW_WIDTH) / 2);
    const initialY = workAreaY + 21;
        
    const header = new BrowserWindow({
        width: DEFAULT_WINDOW_WIDTH,
        height: HEADER_HEIGHT,
        x: initialX,
        y: initialY,
        frame: false,
        transparent: true,
        vibrancy: false,
        hasShadow: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hiddenInMissionControl: true,
        resizable: false,
        focusable: true,
        acceptFirstMouse: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '../preload.js'),
            backgroundThrottling: false,
            webSecurity: false,
            enableRemoteModule: false,
            // Ensure proper rendering and prevent pixelation
            experimentalFeatures: false,
        },
        // Prevent pixelation and ensure proper rendering
        useContentSize: true,
        disableAutoHideCursor: true,
    });
    if (process.platform === 'darwin') {
        header.setWindowButtonVisibility(false);
    }
    const headerLoadOptions = {};
    if (!shouldUseLiquidGlass) {
        header.loadFile(path.join(__dirname, '../ui/app/header.html'), headerLoadOptions);
    }
    else {
        headerLoadOptions.query = { glass: 'true' };
        header.loadFile(path.join(__dirname, '../ui/app/header.html'), headerLoadOptions);
        header.webContents.once('did-finish-load', () => {
            const viewId = liquidGlass.addView(header.getNativeWindowHandle());
            if (viewId !== -1) {
                liquidGlass.unstable_setVariant(viewId, liquidGlass.GlassMaterialVariant.bubbles);
                // liquidGlass.unstable_setScrim(viewId, 1); 
                // liquidGlass.unstable_setSubdued(viewId, 1);
            }
        });
    }
    windowPool.set('header', header);
    layoutManager = new WindowLayoutManager(windowPool);
    movementManager = new SmoothMovementManager(windowPool);


    header.on('moved', () => {
        // Windows you placed move along with the header; remember where they are now.
        for (const name of ['listen', 'ask']) {
            const w = windowPool.get(name);
            if (userPlaced[name] && w && !w.isDestroyed() && w.isVisible()) {
                userPlaced[name].bounds = w.getBounds();
                savePlacement();
            }
        }
        if (movementManager.isAnimating) {
            return;
        }
        updateChildWindowLayouts(false);
    });

    header.webContents.once('dom-ready', () => {
        shortcutsService.initialize(windowPool);
        shortcutsService.registerShortcuts();
    });

    setupIpcHandlers(windowPool, layoutManager);
    setupWindowController(windowPool, layoutManager, movementManager);

    if (currentHeaderState === 'main') {
        createFeatureWindows(header, ['listen', 'ask', 'settings', 'shortcut-settings']);
    }

    header.setContentProtection(isContentProtectionOn);
    header.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    
    // Open DevTools in development
    if (SHOW_DEVTOOLS) {
        header.webContents.openDevTools({ mode: 'detach' });
    }

    header.on('focus', () => {
        console.log('[WindowManager] Header gained focus');
    });

    header.on('blur', () => {
        console.log('[WindowManager] Header lost focus');
    });

    header.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'mouseDown') {
            const target = input.target;
            if (target && (target.includes('input') || target.includes('apikey'))) {
                header.focus();
            }
        }
    });

    header.on('resize', () => updateChildWindowLayouts(false));

    return windowPool;
}


function setupIpcHandlers(windowPool, layoutManager) {
    screen.on('display-added', (event, newDisplay) => {
        console.log('[Display] New display added:', newDisplay.id);
    });

    screen.on('display-removed', (event, oldDisplay) => {
        console.log('[Display] Display removed:', oldDisplay.id);
        const header = windowPool.get('header');

        if (header && getCurrentDisplay(header).id === oldDisplay.id) {
            const primaryDisplay = screen.getPrimaryDisplay();
            const newPosition = layoutManager.calculateNewPositionForDisplay(header, primaryDisplay.id);
            if (newPosition) {
                // 복구 상황이므로 애니메이션 없이 즉시 이동
                header.setPosition(newPosition.x, newPosition.y, false);
                updateChildWindowLayouts(false);
            }
        }
    });

    screen.on('display-metrics-changed', (event, display, changedMetrics) => {
        // 레이아웃 업데이트 함수를 새 버전으로 호출
        updateChildWindowLayouts(false);
    });
}


const handleHeaderStateChanged = (state) => {
    console.log(`[WindowManager] Header state changed to: ${state}`);
    currentHeaderState = state;

    if (state === 'main') {
        createFeatureWindows(windowPool.get('header'));
    } else {         // 'apikey' | 'permission'
        destroyFeatureWindows();
    }
    internalBridge.emit('reregister-shortcuts');
};


module.exports = {
    createWindows,
    windowPool,
    toggleContentProtection,
    resizeHeaderWindow,
    getContentProtectionStatus,
    showSettingsWindow,
    hideSettingsWindow,
    cancelHideSettingsWindow,
    openLoginPage,
    moveWindowStep,
    handleHeaderStateChanged,
    handleHeaderAnimationFinished,
    getHeaderPosition,
    moveHeaderTo,
    adjustWindowHeight,
    resetWindowPlacement,
};