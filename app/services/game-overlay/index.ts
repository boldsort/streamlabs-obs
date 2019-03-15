import electron from 'electron';
import { fromEvent, Subject, Subscription } from 'rxjs';
import { delay, take } from 'rxjs/operators';
import overlay, { OverlayThreadStatus } from '@streamlabs/game-overlay';
import { Inject } from 'util/injector';
import { InitAfter } from 'util/service-observer';
import { LoginLifecycle, UserService } from 'services/user';
import { CustomizationService } from 'services/customization';
import { getPlatformService } from '../platforms';
import { WindowsService } from '../windows';
import { PersistentStatefulService } from '../persistent-stateful-service';
import { mutation } from '../stateful-service';

const { BrowserWindow, BrowserView } = electron.remote;

/**
 * We need to show the windows so the overlay system can capture its contents.
 * Workaround is to render them offscreen via positioning.
 */
const OFFSCREEN_OFFSET = 5000;

export type GameOverlayState = {
  isEnabled: boolean;
  isShowing: boolean;
  isPreviewEnabled: boolean;
};

@InitAfter('UserService')
@InitAfter('WindowsService')
export class GameOverlayService extends PersistentStatefulService<GameOverlayState> {
  @Inject() userService: UserService;
  @Inject() customizationService: CustomizationService;
  @Inject() windowsService: WindowsService;

  static defaultState: GameOverlayState = {
    isEnabled: false,
    isShowing: false,
    isPreviewEnabled: true,
  };

  windows: {
    chat: Electron.BrowserWindow;
    recentEvents: Electron.BrowserWindow;
    overlayControls: Electron.BrowserWindow;
  } = {} as any;
  overlayWindow: Electron.BrowserWindow;
  onWindowsReady: Subject<Electron.BrowserWindow> = new Subject<Electron.BrowserWindow>();
  onWindowsReadySubscription: Subscription;
  lifecycle: LoginLifecycle;

  async init() {
    super.init();

    if (!this.state.isEnabled) {
      return;
    }

    this.lifecycle = await this.userService.withLifecycle({
      init: this.createOverlay,
      destroy: this.destroyOverlay,
      context: this,
    });

    // TODO: better way to track shutdown
    electron.ipcRenderer.once('shutdownComplete', () => {
      overlay.stop();
    });
  }

  async createOverlay() {
    overlay.start();

    this.onWindowsReadySubscription = this.onWindowsReady
      .pipe(
        take(Object.keys(this.windows).length),
        delay(5000), // so recent events has time to load
      )
      .subscribe({
        complete: () => {
          Object.values(this.windows).forEach(win => {
            win.showInactive();

            const overlayId = overlay.addHWND(win.getNativeWindowHandle());

            if (overlayId.toString() === '-1') {
              this.overlayWindow.hide();
              throw new Error('Error creating overlay');
            }

            const [x, y] = win.getPosition();
            const { width, height } = win.getBounds();

            overlay.setPosition(overlayId, x - OFFSCREEN_OFFSET, y, width, height);
            overlay.setTransparency(overlayId, 255);
          });
        },
      });

    const display = this.windowsService.getMainWindowDisplay();

    const [containerX, containerY] = [
      display.workArea.width / 2 + 200 + OFFSCREEN_OFFSET,
      display.workArea.height / 2 - 300,
    ];

    const commonWindowOptions = {
      backgroundColor: this.customizationService.nightMode ? '#17242d' : '#fff',
      show: false,
      frame: false,
      width: 300,
      height: 300,
      skipTaskbar: true,
      thickFrame: false,
      webPreferences: {
        nodeIntegration: false,
      },
    };

    this.overlayWindow = new BrowserWindow({
      ...commonWindowOptions,
      height: 600,
      width: 600,
      x: containerX,
      y: containerY,
    });

    const commonBrowserViewOptions = {
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    };

    this.windows.recentEvents = new BrowserWindow({
      ...commonWindowOptions,
      width: 600,
      x: containerX - 600,
      y: containerY,
      parent: this.overlayWindow,
    });

    this.windows.chat = new BrowserWindow({
      ...commonWindowOptions,
      x: containerX,
      y: containerY,
      height: 600,
      parent: this.overlayWindow,
    });

    const recentEventsBrowserView = new BrowserView(commonBrowserViewOptions);
    const chatBrowserView = new BrowserView(commonBrowserViewOptions);

    this.windows.recentEvents.webContents.once('did-finish-load', () => {
      this.onWindowsReady.next(this.windows.recentEvents);
    });

    this.windows.chat.webContents.once('did-finish-load', () =>
      this.onWindowsReady.next(this.windows.chat),
    );

    const makeDraggable = `
      document.querySelector('body').style['-webkit-app-region'] = 'drag';
      const el = document.querySelector('.tw-absolute')
      if (el) { el.style['-webkit-app-region'] = 'drag' };
      
      document.styleSheets[0].addRule("li, a, button, input, .mission-control-wrapper, .mission-control, .room-selector .rooms-header .tw-flex, .chat-room", "-webkit-app-region: no-drag", 1);
    `;

    this.windows.recentEvents.setBounds({
      x: containerX - 600,
      y: containerY,
      width: 600,
      height: 300,
    });

    this.windows.chat.setBounds({ x: containerX, y: containerY, width: 300, height: 600 });

    recentEventsBrowserView.webContents.loadURL(this.userService.recentEventsUrl());
    chatBrowserView.webContents.loadURL(
      await getPlatformService(this.userService.platform.type).getChatUrl(
        this.customizationService.nightMode ? 'night' : 'day',
      ),
    );

    for (const view of [this.windows.recentEvents, this.windows.chat]) {
      view.webContents.once('dom-ready', async () => {
        await view.webContents.executeJavaScript(makeDraggable);
      });
    }

    this.windows.recentEvents.loadURL(this.userService.recentEventsUrl());
    this.windows.chat.loadURL(
      await getPlatformService(this.userService.platform.type).getChatUrl(
        this.customizationService.nightMode ? 'night' : 'day',
      ),
    );

    this.windows.overlayControls = this.windowsService.createOneOffWindowForOverlay(
      {
        ...commonWindowOptions,
        // @ts-ignore
        webPreferences: {},
        parent: this.overlayWindow,
        x: containerX - 600,
        y: containerY + 300,
        width: 600,
        height: 300,
        // OneOffWindow options
        isFullScreen: true,
        componentName: 'OverlayWindow',
      },
      'overlay',
    );

    // Listen for the second dom-ready as we trigger a reload as a workaround for a blank screen
    fromEvent(this.windows.overlayControls.webContents, 'dom-ready')
      .pipe(take(2))
      .subscribe({
        complete: () => this.onWindowsReady.next(this.windows.overlayControls),
      });

    this.windows.overlayControls.webContents.once('dom-ready', async () => {
      this.windows.overlayControls.reload();
      await this.windows.overlayControls.webContents.executeJavaScript(makeDraggable);
    });
  }

  showOverlay() {
    overlay.show();
    this.TOGGLE_OVERLAY(true);
  }

  hideOverlay() {
    overlay.hide();
    this.TOGGLE_OVERLAY(false);
  }

  toggleOverlay() {
    if (overlay.getStatus() !== OverlayThreadStatus.Running) {
      return;
    }

    this.state.isShowing ? this.hideOverlay() : this.showOverlay();
  }

  isEnabled() {
    return this.state.isEnabled;
  }

  setEnabled(shouldEnable: boolean = true) {
    const shouldStart = shouldEnable && !this.state.isEnabled;
    const shouldStop = !shouldEnable && this.state.isEnabled;

    if (shouldStart) {
      this.createOverlay();
    }

    if (shouldStop) {
      this.destroyOverlay();
    }

    this.SET_ENABLED(shouldEnable);
  }

  setPreviewEnabled(shouldEnable: boolean = true) {
    this.SET_PREVIEW_ENABLED(shouldEnable);
  }

  @mutation()
  private SET_PREVIEW_ENABLED(isEnabled: boolean) {
    this.state.isPreviewEnabled = isEnabled;
  }

  @mutation()
  private TOGGLE_OVERLAY(isShowing: boolean) {
    this.state.isShowing = isShowing;
  }

  @mutation()
  private SET_ENABLED(shouldEnable: boolean = true) {
    this.state.isEnabled = shouldEnable;
  }

  async destroyed() {
    await this.lifecycle.destroy();
  }

  async destroyOverlay() {
    overlay.stop();
    this.onWindowsReadySubscription.unsubscribe();
    Object.values(this.windows).forEach(win => win.destroy());
  }
}
