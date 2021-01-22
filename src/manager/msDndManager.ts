/** Gnome libs imports */
import * as GLib from 'GLib';
import * as Meta from 'Meta';
import * as Clutter from 'Clutter';
import * as GObject from 'GObject';
const Main = imports.ui.main;

/** Extension imports */
const Me = imports.misc.extensionUtils.getCurrentExtension();
import { MsWindow } from 'src/layout/msWorkspace/msWindow';
import { reparentActor, throttle } from 'src/utils/index';
import { MsManager } from 'src/manager/msManager';
import { KeyBindingAction } from 'src/module/hotKeysModule';
import { MsWindowManager } from './msWindowManager';
import { registerGObjectClass } from 'src/utils/gjs';

export class MsDndManager extends MsManager {
    msWindowDragged: MsWindow | null | undefined;
    msWindowManager: MsWindowManager;
    signalMap: Map<any, any>;
    dragInProgress: boolean;
    originalParent: any;
    inputGrabber: InputGrabber;
    throttledCheckUnderPointer: (this: any) => any;
    originPointerAnchor: number[] | undefined;

    constructor(msWindowManager: MsWindowManager) {
        super();
        this.msWindowDragged = null;
        this.msWindowManager = msWindowManager;
        this.signalMap = new Map();
        this.dragInProgress = false;
        this.inputGrabber = new InputGrabber();
        this.observe(this.msWindowManager, 'ms-window-created', () => {
            this.listenForMsWindowsSignal();
        });
        this.listenForMsWindowsSignal();

        this.observe(
            global.workspace_manager,
            'active-workspace-changed',
            () => {
                if (this.dragInProgress) {
                    const newMsWorkspace = Me.msWorkspaceManager.getActivePrimaryMsWorkspace();
                    if (this.msWindowDragged.metaWindow) {
                        this.msWindowDragged.metaWindow.change_workspace_by_index(
                            global.workspace_manager.get_active_workspace_index(),
                            true
                        );
                    } else {
                        Me.msWorkspaceManager.setWindowToMsWorkspace(
                            this.msWindowDragged,
                            newMsWorkspace
                        );
                    }

                    this.originalParent =
                        newMsWorkspace.msWorkspaceActor.tileableContainer;
                }
            }
        );

        this.observe(
            global.display,
            'grab-op-begin',
            (_, display, metaWindow, op) => {
                if (op === Meta.GrabOp.MOVING) {
                    let msWindow = metaWindow.msWindow;
                    if (
                        msWindow &&
                        msWindow.metaWindow === metaWindow &&
                        !msWindow.followMetaWindow
                    ) {
                        global.display.end_grab_op(global.get_current_time());
                        this.startDrag(msWindow);
                    }
                }
            }
        );

        this.observe(global.stage, 'captured-event', (_, event) => {
            if (this.dragInProgress) {
                let [stageX, stageY] = event.get_coords();
                switch (event.type()) {
                    case Clutter.EventType.MOTION:
                        this.msWindowDragged.set_position(
                            Math.round(
                                stageX -
                                this.msWindowDragged.width *
                                this.originPointerAnchor[0]
                            ),
                            Math.round(
                                stageY -
                                this.msWindowDragged.height *
                                this.originPointerAnchor[1]
                            )
                        );
                        this.throttledCheckUnderPointer();
                        break;
                    case Clutter.EventType.BUTTON_RELEASE:
                        this.endDrag();
                        break;
                }
            }
        });

        this.throttledCheckUnderPointer = throttle(
            this.checkUnderThePointer,
            50,
            { trailing: false }
        );
    }

    /**
     * Handle drag and drop for placeholders
     */
    listenForMsWindowsSignal() {
        this.msWindowManager.msWindowList.forEach((msWindow) => {
            if (!this.signalMap.has(msWindow)) {
                const id = msWindow.connect('event', (_, event) => {
                    if (this.dragInProgress) return;
                    switch (event.type()) {
                        case Clutter.EventType.MOTION:
                            if (event.get_state() === 320) {
                                this.startDrag(msWindow);
                            }
                            break;
                    }
                });
                this.signalMap.set(msWindow, id);
            }
        });
    }

    startDrag(msWindow) {
        global.stage.add_child(this.inputGrabber);
        this.dragInProgress = true;
        this.msWindowDragged = msWindow;
        this.originalParent = msWindow.get_parent();
        msWindow.freezeAllocation();
        this.msWindowManager.msWindowList.forEach((aMsWindow) => {
            aMsWindow.updateMetaWindowVisibility();
        });
        let [globalX, globalY] = global.get_pointer();
        let [_, relativeX, relativeY] = msWindow.transform_stage_point(
            globalX,
            globalY
        );
        this.originPointerAnchor = [
            relativeX / msWindow.width,
            relativeY / msWindow.height,
        ];

        Me.layout.setActorAbove(msWindow);
        this.checkUnderThePointerRoutine();
        msWindow.set_position(
            Math.round(globalX - msWindow.width * this.originPointerAnchor[0]),
            Math.round(globalY - msWindow.height * this.originPointerAnchor[1])
        );
        Main.pushModal(this.inputGrabber);
        global.display.set_cursor(Meta.Cursor.DND_IN_DRAG);
    }

    endDrag() {
        Main.popModal(this.inputGrabber);
        global.stage.remove_child(this.inputGrabber);
        this.msWindowDragged.unFreezeAllocation();
        reparentActor(this.msWindowDragged, this.originalParent);
        this.dragInProgress = false;
        delete this.originPointerAnchor;
        delete this.originalParent;
        delete this.msWindowDragged;
        this.msWindowManager.msWindowList.forEach((aMsWindow) => {
            aMsWindow.updateMetaWindowVisibility();
        });
        global.display.set_cursor(Meta.Cursor.DEFAULT);
    }

    checkUnderThePointerRoutine() {
        if (!this.dragInProgress) return;
        this.throttledCheckUnderPointer();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this.checkUnderThePointerRoutine();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**  */
    checkUnderThePointer() {
        let [x, y] = global.get_pointer();
        let monitor = Main.layoutManager.currentMonitor;

        //Check for all tileable of the msWindow's msWorkspace if the pointer is above another msWindow
        const msWorkspace = this.msWindowDragged.msWorkspace;
        if (monitor !== msWorkspace.monitor) {
            let newMsWorkspace;
            if (monitor === Main.layoutManager.primaryMonitor) {
                newMsWorkspace = Me.msWorkspaceManager.getActivePrimaryMsWorkspace();
            } else {
                newMsWorkspace = Me.msWorkspaceManager.getMsWorkspacesOfMonitorIndex(
                    monitor.index
                )[0];
            }

            Me.msWorkspaceManager.setWindowToMsWorkspace(
                this.msWindowDragged,
                newMsWorkspace
            );

            this.originalParent =
                newMsWorkspace.msWorkspaceActor.tileableContainer;
        }

        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            msWorkspace.monitor.index
        );
        let relativeX = x - workArea.x;
        let relativeY = y - workArea.y;

        msWorkspace.tileableList
            .filter(
                (tileable) =>
                    tileable instanceof MsWindow &&
                    tileable.visible &&
                    tileable.get_parent() ===
                    msWorkspace.msWorkspaceActor.tileableContainer
            )
            .forEach((tileable) => {
                if (
                    relativeX >= tileable.x &&
                    relativeX <= tileable.x + tileable.width &&
                    relativeY >= tileable.y &&
                    relativeY <= tileable.y + tileable.height
                ) {
                    msWorkspace.swapTileable(this.msWindowDragged, tileable);
                }
            });
    }
};

@registerGObjectClass
export class InputGrabber extends Clutter.Actor {
    constructor() {
        super({
            name: 'InputGrabber',
            reactive: true,
        });
        this.add_constraint(
            new Clutter.BindConstraint({
                source: global.stage,
                coordinate: Clutter.BindCoordinate.ALL,
            })
        );
    }
    vfunc_key_press_event(keyEvent: Clutter.KeyEvent) {
        let actionId = global.display.get_keybinding_action(
            keyEvent.hardware_keycode,
            keyEvent.modifier_state
        );
        if (Me.hotKeysModule.actionIdToNameMap.has(actionId)) {
            const actionName = Me.hotKeysModule.actionIdToNameMap.get(
                actionId
            );
            switch (actionName) {
                case KeyBindingAction.PREVIOUS_WINDOW:
                    Me.hotKeysModule.actionNameToActionMap.get(
                        KeyBindingAction.MOVE_WINDOW_LEFT
                    )();
                    break;
                case KeyBindingAction.NEXT_WINDOW:
                    Me.hotKeysModule.actionNameToActionMap.get(
                        KeyBindingAction.MOVE_WINDOW_RIGHT
                    )();
                    break;
                case KeyBindingAction.PREVIOUS_WORKSPACE:
                    Me.hotKeysModule.actionNameToActionMap.get(
                        KeyBindingAction.MOVE_WINDOW_TOP
                    )();
                    break;
                case KeyBindingAction.NEXT_WORKSPACE:
                    Me.hotKeysModule.actionNameToActionMap.get(
                        KeyBindingAction.MOVE_WINDOW_BOTTOM
                    )();
                    break;
            }
        }
        return false;
    }
}
