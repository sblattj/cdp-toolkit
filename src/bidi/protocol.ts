/**
 * WebDriver BiDi wire protocol types, for the Firefox backend.
 *
 * Derived directly from the spec's own CDDL (w3c/webdriver-bidi@6a2835c,
 * index.bs). Pure types file: no runtime code, zero imports.
 *
 * Scope: session (5 commands), browsingContext (15 commands, 14 events),
 * script (6 commands, 3 events), input (3 commands, 1 event), network
 * (13 commands, 5 events), log (1 event), storage (3 commands), emulation
 * (13 commands). browser and webExtension modules are out of scope, except
 * for two leaf types (BrowserUserContext, BrowserClientWindow) that in-scope
 * modules reference by value.
 *
 * Naming: CDDL `module.Name` becomes `ModuleName` (PascalCase, no dot), this
 * file's flat-export house style rather than TS namespaces.
 *
 * Nine commands are not implemented by Firefox 153. They are still typed in
 * full (these types describe the spec, not one browser); each carries a
 * one-line "Firefox 153: not implemented" comment.
 */

// --- Envelope (spec: "Definition", "Commands", "Events") -------------------

/** CDDL: js-uint = 0..9007199254740991 */
export type BidiJsUint = number;
/** CDDL: js-int = -9007199254740991..9007199254740991 */
export type BidiJsInt = number;

/** CDDL: Extensible = (*text => any). Additional impl-defined properties, typed unknown (not any). */
export interface BidiExtensible {
  [key: string]: unknown;
}

export interface BidiCommandMessage<M extends BidiMethod = BidiMethod> {
  id: BidiJsUint;
  method: M;
  params: BidiCommands[M]["params"];
}
/** CommandResponse = { type: "success", id, result: ResultData, Extensible } */
export interface BidiSuccessResponse<M extends BidiMethod = BidiMethod> extends BidiExtensible {
  type: "success";
  id: BidiJsUint;
  result: BidiCommands[M]["result"];
}
/** ErrorResponse = { type: "error", id: js-uint / null, error, message, ?stacktrace, Extensible } */
export interface BidiErrorResponse extends BidiExtensible {
  type: "error";
  id: BidiJsUint | null;
  error: BidiErrorCode;
  message: string;
  stacktrace?: string;
}
/** Event = { type: "event", EventData, Extensible } */
export interface BidiEvent<E extends BidiEventName = BidiEventName> extends BidiExtensible {
  type: "event";
  method: E;
  params: BidiEvents[E];
}
/** Message = CommandResponse / ErrorResponse / Event. Discriminate on `type`. */
export type BidiMessage = BidiSuccessResponse | BidiErrorResponse | BidiEvent;

/** CDDL: ErrorCode enumeration (spec section "Errors"). */
export type BidiErrorCode =
  | "invalid argument" | "invalid selector" | "invalid session id" | "invalid web extension"
  | "move target out of bounds" | "no such alert" | "no such network collector" | "no such element"
  | "no such frame" | "no such handle" | "no such history entry" | "no such intercept"
  | "no such network data" | "no such node" | "no such request" | "no such screencast"
  | "no such script" | "no such storage partition" | "no such user context" | "no such web extension"
  | "session not created" | "unable to capture screen" | "unable to close browser" | "unable to set cookie"
  | "unable to set file input" | "unavailable network data" | "underspecified storage partition"
  | "unknown command" | "unknown error" | "unsupported operation";

/** CDDL: EmptyParams = { Extensible } */
export type BidiEmptyParams = BidiExtensible;
/** CDDL: EmptyResult = { Extensible } */
export type BidiEmptyResult = BidiExtensible;

// --- browser module leaf types (module out of scope; values referenced) ----

/** CDDL: browser.UserContext = text */
export type BrowserUserContext = string;
/** CDDL: browser.ClientWindow = text */
export type BrowserClientWindow = string;

// --- session module ----------------------------------------------------

export interface SessionCapabilitiesRequest { alwaysMatch?: SessionCapabilityRequest; firstMatch?: SessionCapabilityRequest[] }
export interface SessionCapabilityRequest extends BidiExtensible {
  acceptInsecureCerts?: boolean; browserName?: string; browserVersion?: string; platformName?: string;
  proxy?: SessionProxyConfiguration; unhandledPromptBehavior?: SessionUserPromptHandler;
}
export type SessionProxyConfiguration =
  | SessionAutodetectProxyConfiguration | SessionDirectProxyConfiguration
  | SessionManualProxyConfiguration | SessionPacProxyConfiguration | SessionSystemProxyConfiguration;
export interface SessionAutodetectProxyConfiguration extends BidiExtensible { proxyType: "autodetect" }
export interface SessionDirectProxyConfiguration extends BidiExtensible { proxyType: "direct" }
export interface SessionManualProxyConfiguration extends BidiExtensible {
  proxyType: "manual"; httpProxy?: string; sslProxy?: string; socksProxy?: string; socksVersion?: number; noProxy?: string[];
}
export interface SessionPacProxyConfiguration extends BidiExtensible { proxyType: "pac"; proxyAutoconfigUrl: string }
export interface SessionSystemProxyConfiguration extends BidiExtensible { proxyType: "system" }

export interface SessionUserPromptHandler {
  alert?: SessionUserPromptHandlerType; beforeUnload?: SessionUserPromptHandlerType; confirm?: SessionUserPromptHandlerType;
  default?: SessionUserPromptHandlerType; file?: SessionUserPromptHandlerType; prompt?: SessionUserPromptHandlerType;
}
export type SessionUserPromptHandlerType = "accept" | "dismiss" | "ignore";

/** CDDL: session.Subscription = text (a subscription id) */
export type SessionSubscription = string;
export interface SessionSubscribeParameters { events: string[]; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[] }
export interface SessionUnsubscribeByIDRequest { subscriptions: SessionSubscription[] }
export interface SessionUnsubscribeByAttributesRequest { events: string[] }
export type SessionUnsubscribeParameters = SessionUnsubscribeByAttributesRequest | SessionUnsubscribeByIDRequest;

export interface SessionStatusResult { ready: boolean; message: string }
export interface SessionNewParameters { capabilities: SessionCapabilitiesRequest }
export interface SessionNewResult {
  sessionId: string;
  capabilities: {
    acceptInsecureCerts: boolean; browserName: string; browserVersion: string; platformName: string;
    setWindowRect: boolean; userAgent: string; proxy?: SessionProxyConfiguration;
    unhandledPromptBehavior?: SessionUserPromptHandler; webSocketUrl?: string;
  } & BidiExtensible;
}
export interface SessionSubscribeResult { subscription: SessionSubscription }

// --- browsingContext module ---------------------------------------------

/** CDDL: browsingContext.BrowsingContext = text */
export type BrowsingContextId = string;
/** CDDL: browsingContext.Navigation = text */
export type BrowsingContextNavigation = string;
/** CDDL: browsingContext.Download = text */
export type BrowsingContextDownload = string;
/** CDDL: browsingContext.Screencast = text */
export type BrowsingContextScreencast = string;
export type BrowsingContextReadinessState = "none" | "interactive" | "complete";
export type BrowsingContextUserPromptType = "alert" | "beforeunload" | "confirm" | "prompt";

export interface BrowsingContextInfo {
  children: BrowsingContextInfo[] | null; clientWindow: BrowserClientWindow; context: BrowsingContextId;
  originalOpener: BrowsingContextId | null; url: string; userContext: BrowserUserContext; parent?: BrowsingContextId | null;
}
export type BrowsingContextInfoList = BrowsingContextInfo[];

export type BrowsingContextLocator =
  | BrowsingContextAccessibilityLocator | BrowsingContextCssLocator | BrowsingContextContextLocator
  | BrowsingContextInnerTextLocator | BrowsingContextXPathLocator;
export interface BrowsingContextAccessibilityLocator { type: "accessibility"; value: { name?: string; role?: string } }
export interface BrowsingContextCssLocator { type: "css"; value: string }
export interface BrowsingContextContextLocator { type: "context"; value: { context: BrowsingContextId } }
export interface BrowsingContextInnerTextLocator {
  type: "innerText"; value: string; ignoreCase?: boolean; matchType?: "full" | "partial"; maxDepth?: BidiJsUint;
}
export interface BrowsingContextXPathLocator { type: "xpath"; value: string }

export interface BrowsingContextBaseNavigationInfo {
  context: BrowsingContextId; navigation: BrowsingContextNavigation | null; timestamp: BidiJsUint;
  url: string; userContext?: BrowserUserContext;
}
export type BrowsingContextNavigationInfo = BrowsingContextBaseNavigationInfo;

export interface BrowsingContextActivateParameters { context: BrowsingContextId }
export type BrowsingContextActivateResult = BidiEmptyResult;

export interface BrowsingContextCaptureScreenshotParameters {
  context: BrowsingContextId; origin?: "viewport" | "document" /* default "viewport" */;
  format?: BrowsingContextImageFormat; clip?: BrowsingContextClipRectangle;
}
/** Spec types `type` as bare `text` (e.g. "image/png"), not an enumerated literal. */
export interface BrowsingContextImageFormat { type: string; quality?: number }
export type BrowsingContextClipRectangle = BrowsingContextBoxClipRectangle | BrowsingContextElementClipRectangle;
export interface BrowsingContextElementClipRectangle { type: "element"; element: ScriptSharedReference }
export interface BrowsingContextBoxClipRectangle { type: "box"; x: number; y: number; width: number; height: number }
export interface BrowsingContextCaptureScreenshotResult { data: string }

export interface BrowsingContextCloseParameters { context: BrowsingContextId; promptUnload?: boolean /* default false */ }
export type BrowsingContextCloseResult = BidiEmptyResult;

export type BrowsingContextCreateType = "tab" | "window";
export interface BrowsingContextCreateParameters {
  type: BrowsingContextCreateType; referenceContext?: BrowsingContextId; background?: boolean; userContext?: BrowserUserContext;
}
export interface BrowsingContextCreateResult { context: BrowsingContextId; userContext?: BrowserUserContext }

export interface BrowsingContextGetTreeParameters { maxDepth?: BidiJsUint; root?: BrowsingContextId }
export interface BrowsingContextGetTreeResult { contexts: BrowsingContextInfoList }

export interface BrowsingContextHandleUserPromptParameters { context: BrowsingContextId; accept?: boolean; userText?: string }
export type BrowsingContextHandleUserPromptResult = BidiEmptyResult;

export interface BrowsingContextLocateNodesParameters {
  context: BrowsingContextId; locator: BrowsingContextLocator; maxNodeCount?: BidiJsUint /* .ge 1 */;
  serializationOptions?: ScriptSerializationOptions; startNodes?: [ScriptSharedReference, ...ScriptSharedReference[]];
}
export interface BrowsingContextLocateNodesResult { nodes: ScriptNodeRemoteValue[] }

export interface BrowsingContextNavigateParameters { context: BrowsingContextId; url: string; wait?: BrowsingContextReadinessState }
export interface BrowsingContextNavigateResult { navigation: BrowsingContextNavigation | null; url: string }

export interface BrowsingContextPrintParameters {
  context: BrowsingContextId; background?: boolean; margin?: BrowsingContextPrintMarginParameters;
  orientation?: "portrait" | "landscape"; page?: BrowsingContextPrintPageParameters;
  pageRanges?: Array<BidiJsUint | string>; scale?: number /* 0.1..2.0 default 1.0 */; shrinkToFit?: boolean;
}
export interface BrowsingContextPrintMarginParameters { bottom?: number; left?: number; right?: number; top?: number }
export interface BrowsingContextPrintPageParameters { height?: number; width?: number }
export interface BrowsingContextPrintResult { data: string }

export interface BrowsingContextReloadParameters { context: BrowsingContextId; ignoreCache?: boolean; wait?: BrowsingContextReadinessState }
export type BrowsingContextReloadResult = BrowsingContextNavigateResult;

/** Firefox 153: not implemented. */
export interface BrowsingContextSetBypassCSPParameters { bypass: true | null; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[] }
export type BrowsingContextSetBypassCSPResult = BidiEmptyResult;

export interface BrowsingContextViewport { width: BidiJsUint; height: BidiJsUint }
export interface BrowsingContextSetViewportParameters {
  context?: BrowsingContextId; viewport?: BrowsingContextViewport | null;
  devicePixelRatio?: number | null /* .gt 0.0 */; userContexts?: BrowserUserContext[];
}
export type BrowsingContextSetViewportResult = BidiEmptyResult;

/** Firefox 153: not implemented. */
export interface BrowsingContextStartScreencastParameters {
  context: BrowsingContextId; mimeType?: string; video?: BrowsingContextMediaTrackConstraints; audio?: boolean /* default false */;
}
export interface BrowsingContextMediaTrackConstraints { width?: BidiJsUint; height?: BidiJsUint; frameRate?: BidiJsUint }
export interface BrowsingContextStartScreencastResult { screencast: BrowsingContextScreencast; path: string }

/** Firefox 153: not implemented. */
export interface BrowsingContextStopScreencastParameters { screencast: BrowsingContextScreencast }
export interface BrowsingContextStopScreencastResult { path: string; error?: string }

export interface BrowsingContextTraverseHistoryParameters { context: BrowsingContextId; delta: BidiJsInt }
export type BrowsingContextTraverseHistoryResult = BidiEmptyResult;

export interface BrowsingContextHistoryUpdatedParameters {
  context: BrowsingContextId; timestamp: BidiJsUint; url: string; userContext?: BrowserUserContext;
}
export interface BrowsingContextDownloadWillBeginParams extends BrowsingContextBaseNavigationInfo {
  download: BrowsingContextDownload; suggestedFilename: string;
}
/** Discriminated on `status`; each variant also carries BrowsingContextBaseNavigationInfo fields. */
export type BrowsingContextDownloadEndParams = BrowsingContextDownloadCanceledParams | BrowsingContextDownloadCompleteParams;
export interface BrowsingContextDownloadCanceledParams extends BrowsingContextBaseNavigationInfo { status: "canceled"; download: BrowsingContextDownload }
export interface BrowsingContextDownloadCompleteParams extends BrowsingContextBaseNavigationInfo {
  status: "complete"; download: BrowsingContextDownload; filepath: string | null;
}
export interface BrowsingContextUserPromptClosedParameters {
  context: BrowsingContextId; accepted: boolean; type: BrowsingContextUserPromptType; userContext?: BrowserUserContext; userText?: string;
}
export interface BrowsingContextUserPromptOpenedParameters {
  context: BrowsingContextId; handler: SessionUserPromptHandlerType; message: string; type: BrowsingContextUserPromptType;
  userContext?: BrowserUserContext; defaultValue?: string;
}

// --- script module -------------------------------------------------------

/** CDDL: script.Channel = text */
export type ScriptChannel = string;
/** CDDL: script.Handle = text */
export type ScriptHandle = string;
/** CDDL: script.InternalId = text */
export type ScriptInternalId = string;
/** CDDL: script.PreloadScript = text */
export type ScriptPreloadScript = string;
/** CDDL: script.Realm = text */
export type ScriptRealm = string;
/** CDDL: script.SharedId = text */
export type ScriptSharedId = string;
export type ScriptResultOwnership = "root" | "none";

export interface ScriptSerializationOptions {
  maxDomDepth?: BidiJsUint | null; maxObjectDepth?: BidiJsUint | null; includeShadowTree?: "none" | "open" | "all";
}
export interface ScriptChannelProperties { channel: ScriptChannel; serializationOptions?: ScriptSerializationOptions; ownership?: ScriptResultOwnership }
export interface ScriptChannelValue { type: "channel"; value: ScriptChannelProperties }

/** script.Target: a realm, or a context (optionally scoped to a preload-script sandbox). */
export type ScriptTarget = ScriptContextTarget | ScriptRealmTarget;
export interface ScriptContextTarget { context: BrowsingContextId; sandbox?: string }
export interface ScriptRealmTarget { realm: ScriptRealm }

/**
 * script.RemoteReference: a SharedReference (DOM node, by sharedId) or a
 * RemoteObjectReference (any JS object, by handle). Spec notes CDDL match
 * order matters here because the shapes overlap; SharedReference tried first.
 */
export type ScriptRemoteReference = ScriptSharedReference | ScriptRemoteObjectReference;
export interface ScriptSharedReference extends BidiExtensible { sharedId: ScriptSharedId; handle?: ScriptHandle }
export interface ScriptRemoteObjectReference extends BidiExtensible { handle: ScriptHandle; sharedId?: ScriptSharedId }

export type ScriptSpecialNumber = "NaN" | "-0" | "Infinity" | "-Infinity";
export type ScriptPrimitiveProtocolValue =
  | { type: "undefined" } | { type: "null" } | { type: "string"; value: string }
  | { type: "number"; value: number | ScriptSpecialNumber } | { type: "boolean"; value: boolean } | { type: "bigint"; value: string };

export interface ScriptRegExpValue { pattern: string; flags?: string }
export type ScriptRegExpLocalValue = { type: "regexp"; value: ScriptRegExpValue };
export type ScriptDateLocalValue = { type: "date"; value: string };
export type ScriptMappingLocalValue = Array<[ScriptLocalValue | string, ScriptLocalValue]>;
export type ScriptListLocalValue = ScriptLocalValue[];
export interface ScriptArrayLocalValue { type: "array"; value: ScriptListLocalValue }
export interface ScriptMapLocalValue { type: "map"; value: ScriptMappingLocalValue }
export interface ScriptObjectLocalValue { type: "object"; value: ScriptMappingLocalValue }
export interface ScriptSetLocalValue { type: "set"; value: ScriptListLocalValue }
export type ScriptLocalValue =
  | ScriptRemoteReference | ScriptPrimitiveProtocolValue | ScriptChannelValue | ScriptArrayLocalValue
  | ScriptDateLocalValue | ScriptMapLocalValue | ScriptObjectLocalValue | ScriptRegExpLocalValue | ScriptSetLocalValue;

export type ScriptListRemoteValue = ScriptRemoteValue[];
export type ScriptMappingRemoteValue = Array<[ScriptRemoteValue | string, ScriptRemoteValue]>;
interface ScriptRemoteValueBase { handle?: ScriptHandle; internalId?: ScriptInternalId }
export interface ScriptSymbolRemoteValue extends ScriptRemoteValueBase { type: "symbol" }
export interface ScriptArrayRemoteValue extends ScriptRemoteValueBase { type: "array"; value?: ScriptListRemoteValue }
export interface ScriptObjectRemoteValue extends ScriptRemoteValueBase { type: "object"; value?: ScriptMappingRemoteValue }
export interface ScriptFunctionRemoteValue extends ScriptRemoteValueBase { type: "function" }
export interface ScriptRegExpRemoteValue extends ScriptRemoteValueBase { type: "regexp"; value: ScriptRegExpValue }
export interface ScriptDateRemoteValue extends ScriptRemoteValueBase { type: "date"; value: string }
export interface ScriptMapRemoteValue extends ScriptRemoteValueBase { type: "map"; value?: ScriptMappingRemoteValue }
export interface ScriptSetRemoteValue extends ScriptRemoteValueBase { type: "set"; value?: ScriptListRemoteValue }
export interface ScriptWeakMapRemoteValue extends ScriptRemoteValueBase { type: "weakmap" }
export interface ScriptWeakSetRemoteValue extends ScriptRemoteValueBase { type: "weakset" }
export interface ScriptGeneratorRemoteValue extends ScriptRemoteValueBase { type: "generator" }
export interface ScriptErrorRemoteValue extends ScriptRemoteValueBase { type: "error" }
export interface ScriptProxyRemoteValue extends ScriptRemoteValueBase { type: "proxy" }
export interface ScriptPromiseRemoteValue extends ScriptRemoteValueBase { type: "promise" }
export interface ScriptTypedArrayRemoteValue extends ScriptRemoteValueBase { type: "typedarray" }
export interface ScriptArrayBufferRemoteValue extends ScriptRemoteValueBase { type: "arraybuffer" }
export interface ScriptNodeListRemoteValue extends ScriptRemoteValueBase { type: "nodelist"; value?: ScriptListRemoteValue }
export interface ScriptHTMLCollectionRemoteValue extends ScriptRemoteValueBase { type: "htmlcollection"; value?: ScriptListRemoteValue }
export interface ScriptNodeProperties {
  nodeType: BidiJsUint; childNodeCount: BidiJsUint; attributes?: Record<string, string>; children?: ScriptNodeRemoteValue[];
  localName?: string; mode?: "open" | "closed"; namespaceURI?: string; nodeValue?: string; shadowRoot?: ScriptNodeRemoteValue | null;
}
/** The variant carrying `sharedId`, so a DOM node result can be resolved back into a SharedReference. */
export interface ScriptNodeRemoteValue extends ScriptRemoteValueBase { type: "node"; sharedId?: ScriptSharedId; value?: ScriptNodeProperties }
export interface ScriptWindowProxyRemoteValue extends ScriptRemoteValueBase { type: "window"; value: { context: BrowsingContextId } }
export type ScriptRemoteValue =
  | ScriptPrimitiveProtocolValue | ScriptSymbolRemoteValue | ScriptArrayRemoteValue | ScriptObjectRemoteValue
  | ScriptFunctionRemoteValue | ScriptRegExpRemoteValue | ScriptDateRemoteValue | ScriptMapRemoteValue
  | ScriptSetRemoteValue | ScriptWeakMapRemoteValue | ScriptWeakSetRemoteValue | ScriptGeneratorRemoteValue
  | ScriptErrorRemoteValue | ScriptProxyRemoteValue | ScriptPromiseRemoteValue | ScriptTypedArrayRemoteValue
  | ScriptArrayBufferRemoteValue | ScriptNodeListRemoteValue | ScriptHTMLCollectionRemoteValue
  | ScriptNodeRemoteValue | ScriptWindowProxyRemoteValue;

export interface ScriptStackFrame { columnNumber: BidiJsUint; functionName: string; lineNumber: BidiJsUint; url: string }
export interface ScriptStackTrace { callFrames: ScriptStackFrame[] }
export interface ScriptExceptionDetails {
  columnNumber: BidiJsUint; exception: ScriptRemoteValue; lineNumber: BidiJsUint; stackTrace: ScriptStackTrace; text: string;
}
export type ScriptEvaluateResult = ScriptEvaluateResultSuccess | ScriptEvaluateResultException;
export interface ScriptEvaluateResultSuccess { type: "success"; result: ScriptRemoteValue; realm: ScriptRealm }
export interface ScriptEvaluateResultException { type: "exception"; exceptionDetails: ScriptExceptionDetails; realm: ScriptRealm }

export type ScriptRealmType =
  | "window" | "dedicated-worker" | "shared-worker" | "service-worker" | "worker" | "paint-worklet" | "audio-worklet" | "worklet";
interface ScriptBaseRealmInfo { realm: ScriptRealm; origin: string }
export interface ScriptWindowRealmInfo extends ScriptBaseRealmInfo {
  type: "window"; context: BrowsingContextId; userContext?: BrowserUserContext; sandbox?: string;
}
export interface ScriptDedicatedWorkerRealmInfo extends ScriptBaseRealmInfo { type: "dedicated-worker"; owners: ScriptRealm[] }
export interface ScriptSharedWorkerRealmInfo extends ScriptBaseRealmInfo { type: "shared-worker" }
export interface ScriptServiceWorkerRealmInfo extends ScriptBaseRealmInfo { type: "service-worker" }
export interface ScriptWorkerRealmInfo extends ScriptBaseRealmInfo { type: "worker" }
export interface ScriptPaintWorkletRealmInfo extends ScriptBaseRealmInfo { type: "paint-worklet" }
export interface ScriptAudioWorkletRealmInfo extends ScriptBaseRealmInfo { type: "audio-worklet" }
export interface ScriptWorkletRealmInfo extends ScriptBaseRealmInfo { type: "worklet" }
export type ScriptRealmInfo =
  | ScriptWindowRealmInfo | ScriptDedicatedWorkerRealmInfo | ScriptSharedWorkerRealmInfo | ScriptServiceWorkerRealmInfo
  | ScriptWorkerRealmInfo | ScriptPaintWorkletRealmInfo | ScriptAudioWorkletRealmInfo | ScriptWorkletRealmInfo;

export interface ScriptSource { realm: ScriptRealm; context?: BrowsingContextId; userContext?: BrowserUserContext }

export interface ScriptAddPreloadScriptParameters {
  functionDeclaration: string; arguments?: ScriptChannelValue[]; contexts?: BrowsingContextId[];
  userContexts?: BrowserUserContext[]; sandbox?: string;
}
export interface ScriptAddPreloadScriptResult { script: ScriptPreloadScript }
export interface ScriptDisownParameters { handles: ScriptHandle[]; target: ScriptTarget }
export type ScriptDisownResult = BidiEmptyResult;
export interface ScriptCallFunctionParameters {
  functionDeclaration: string; awaitPromise: boolean; target: ScriptTarget; arguments?: ScriptLocalValue[];
  resultOwnership?: ScriptResultOwnership; serializationOptions?: ScriptSerializationOptions;
  this?: ScriptLocalValue; userActivation?: boolean /* default false */;
}
export type ScriptCallFunctionResult = ScriptEvaluateResult;
export interface ScriptEvaluateParameters {
  expression: string; target: ScriptTarget; awaitPromise: boolean; resultOwnership?: ScriptResultOwnership;
  serializationOptions?: ScriptSerializationOptions; userActivation?: boolean;
}
export interface ScriptGetRealmsParameters { context?: BrowsingContextId; type?: ScriptRealmType }
export interface ScriptGetRealmsResult { realms: ScriptRealmInfo[] }
export interface ScriptRemovePreloadScriptParameters { script: ScriptPreloadScript }
export type ScriptRemovePreloadScriptResult = BidiEmptyResult;
export interface ScriptMessageParameters { channel: ScriptChannel; data: ScriptRemoteValue; source: ScriptSource }
export interface ScriptRealmDestroyedParameters { realm: ScriptRealm }

// --- input module ----------------------------------------------------------

export interface InputElementOrigin { type: "element"; element: ScriptSharedReference }
export type InputOrigin = "viewport" | "pointer" | InputElementOrigin;
export type InputPointerType = "mouse" | "pen" | "touch";

export interface InputPauseAction { type: "pause"; duration?: BidiJsUint }
export interface InputKeyDownAction { type: "keyDown"; value: string }
export interface InputKeyUpAction { type: "keyUp"; value: string }
export interface InputPointerCommonProperties {
  width?: BidiJsUint; height?: BidiJsUint; pressure?: number /* 0.0..1.0 */; tangentialPressure?: number /* -1.0..1.0 */;
  twist?: number /* 0..359 */; altitudeAngle?: number /* 0..Math.PI/2 */; azimuthAngle?: number /* 0..2*Math.PI */;
}
export interface InputPointerUpAction { type: "pointerUp"; button: BidiJsUint }
export interface InputPointerDownAction extends InputPointerCommonProperties { type: "pointerDown"; button: BidiJsUint }
export interface InputPointerMoveAction extends InputPointerCommonProperties {
  type: "pointerMove"; x: number; y: number; duration?: BidiJsUint; origin?: InputOrigin;
}
export interface InputWheelScrollAction {
  type: "scroll"; x: BidiJsInt; y: BidiJsInt; deltaX: BidiJsInt; deltaY: BidiJsInt;
  duration?: BidiJsUint; origin?: InputOrigin /* default "viewport" */;
}
export type InputNoneSourceAction = InputPauseAction;
export type InputKeySourceAction = InputPauseAction | InputKeyDownAction | InputKeyUpAction;
export type InputPointerSourceAction = InputPauseAction | InputPointerDownAction | InputPointerUpAction | InputPointerMoveAction;
export type InputWheelSourceAction = InputPauseAction | InputWheelScrollAction;

export interface InputNoneSourceActions { type: "none"; id: string; actions: InputNoneSourceAction[] }
export interface InputPointerParameters { pointerType?: InputPointerType /* default "mouse" */ }
export interface InputKeySourceActions { type: "key"; id: string; actions: InputKeySourceAction[] }
export interface InputPointerSourceActions { type: "pointer"; id: string; parameters?: InputPointerParameters; actions: InputPointerSourceAction[] }
export interface InputWheelSourceActions { type: "wheel"; id: string; actions: InputWheelSourceAction[] }
export type InputSourceActions = InputNoneSourceActions | InputKeySourceActions | InputPointerSourceActions | InputWheelSourceActions;

export interface InputPerformActionsParameters { context: BrowsingContextId; actions: InputSourceActions[] }
export type InputPerformActionsResult = BidiEmptyResult;
export interface InputReleaseActionsParameters { context: BrowsingContextId }
export type InputReleaseActionsResult = BidiEmptyResult;
export interface InputSetFilesParameters { context: BrowsingContextId; element: ScriptSharedReference; files: string[] }
export type InputSetFilesResult = BidiEmptyResult;
export interface InputFileDialogInfo {
  context: BrowsingContextId; userContext?: BrowserUserContext; element?: ScriptSharedReference; multiple: boolean;
}

// --- network module ----------------------------------------------------

/** CDDL: network.Request = text (a request id) */
export type NetworkRequest = string;
/** CDDL: network.Intercept = text */
export type NetworkIntercept = string;
/** CDDL: network.Collector = text */
export type NetworkCollector = string;
export type NetworkCollectorType = "blob";
export type NetworkDataType = "request" | "response";
export type NetworkSameSite = "strict" | "lax" | "none" | "default";

export type NetworkBytesValue = NetworkStringValue | NetworkBase64Value;
export interface NetworkStringValue { type: "string"; value: string }
export interface NetworkBase64Value { type: "base64"; value: string }
export interface NetworkHeader { name: string; value: NetworkBytesValue }
export interface NetworkCookieHeader { name: string; value: NetworkBytesValue }
export interface NetworkAuthChallenge { scheme: string; realm: string }
export interface NetworkAuthCredentials { type: "password"; username: string; password: string }

export interface NetworkCookie extends BidiExtensible {
  name: string; value: NetworkBytesValue; domain: string; path: string; size: BidiJsUint;
  httpOnly: boolean; secure: boolean; sameSite: NetworkSameSite; expiry?: BidiJsUint;
}
export interface NetworkSetCookieHeader {
  name: string; value: NetworkBytesValue; domain?: string; httpOnly?: boolean;
  /** Spec types this as `text`, not js-uint: an HTTP-date string, not a timestamp. */
  expiry?: string; maxAge?: BidiJsInt; path?: string; sameSite?: NetworkSameSite; secure?: boolean;
}
export interface NetworkFetchTimingInfo {
  timeOrigin: number; requestTime: number; redirectStart: number; redirectEnd: number; fetchStart: number;
  dnsStart: number; dnsEnd: number; connectStart: number; connectEnd: number; tlsStart: number;
  requestStart: number; responseStart: number; responseEnd: number;
}
export interface NetworkInitiator {
  columnNumber?: BidiJsUint; lineNumber?: BidiJsUint; request?: NetworkRequest; stackTrace?: ScriptStackTrace;
  type?: "parser" | "script" | "preflight" | "other";
}
export interface NetworkRequestData {
  request: NetworkRequest; url: string; method: string; headers: NetworkHeader[]; cookies: NetworkCookie[];
  headersSize: BidiJsUint; bodySize: BidiJsUint | null; destination: string; initiatorType: string | null;
  timings: NetworkFetchTimingInfo;
}
export interface NetworkResponseContent { size: BidiJsUint }
export interface NetworkResponseData {
  url: string; protocol: string; status: BidiJsUint; statusText: string; fromCache: boolean; headers: NetworkHeader[];
  mimeType: string; bytesReceived: BidiJsUint; headersSize: BidiJsUint | null; bodySize: BidiJsUint | null;
  content: NetworkResponseContent; authChallenges?: NetworkAuthChallenge[];
}
export type NetworkUrlPattern = NetworkUrlPatternPattern | NetworkUrlPatternString;
export interface NetworkUrlPatternPattern { type: "pattern"; protocol?: string; hostname?: string; port?: string; pathname?: string; search?: string }
export interface NetworkUrlPatternString { type: "string"; pattern: string }

/** Spread into every network event's params (network.BaseParameters is a CDDL group, not a standalone map). */
export interface NetworkBaseParameters {
  context: BrowsingContextId | null; isBlocked: boolean; navigation: BrowsingContextNavigation | null;
  redirectCount: BidiJsUint; request: NetworkRequestData; timestamp: BidiJsUint;
  userContext?: BrowserUserContext | null; intercepts?: NetworkIntercept[];
}
export type NetworkInterceptPhase = "beforeRequestSent" | "responseStarted" | "authRequired";

export interface NetworkAddDataCollectorParameters {
  dataTypes: NetworkDataType[]; maxEncodedDataSize: BidiJsUint; collectorType?: NetworkCollectorType /* default "blob" */;
  contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[];
}
export interface NetworkAddDataCollectorResult { collector: NetworkCollector }
export interface NetworkAddInterceptParameters { phases: NetworkInterceptPhase[]; contexts?: BrowsingContextId[]; urlPatterns?: NetworkUrlPattern[] }
export interface NetworkAddInterceptResult { intercept: NetworkIntercept }
export interface NetworkContinueRequestParameters {
  request: NetworkRequest; body?: NetworkBytesValue; cookies?: NetworkCookieHeader[]; headers?: NetworkHeader[]; method?: string; url?: string;
}
export type NetworkContinueRequestResult = BidiEmptyResult;
export interface NetworkContinueResponseParameters {
  request: NetworkRequest; cookies?: NetworkSetCookieHeader[]; credentials?: NetworkAuthCredentials;
  headers?: NetworkHeader[]; reasonPhrase?: string; statusCode?: BidiJsUint;
}
export type NetworkContinueResponseResult = BidiEmptyResult;
/**
 * Spec comment flags the "provideCredentials" action literal as unsettled
 * ("or 'provide credentials' or 'providecredentials' or something else").
 * Typed to the primary spelling used in the CDDL production itself.
 */
export type NetworkContinueWithAuthParameters = { request: NetworkRequest } & (
  | { action: "provideCredentials"; credentials: NetworkAuthCredentials } | { action: "default" | "cancel" }
);
export type NetworkContinueWithAuthResult = BidiEmptyResult;
export interface NetworkDisownDataParameters { dataType: NetworkDataType; collector: NetworkCollector; request: NetworkRequest }
export type NetworkDisownDataResult = BidiEmptyResult;
export interface NetworkFailRequestParameters { request: NetworkRequest }
export type NetworkFailRequestResult = BidiEmptyResult;
export interface NetworkGetDataParameters {
  dataType: NetworkDataType; collector?: NetworkCollector; disown?: boolean /* default false */; request: NetworkRequest;
}
export interface NetworkGetDataResult { bytes: NetworkBytesValue }
export interface NetworkProvideResponseParameters {
  request: NetworkRequest; body?: NetworkBytesValue; cookies?: NetworkSetCookieHeader[];
  headers?: NetworkHeader[]; reasonPhrase?: string; statusCode?: BidiJsUint;
}
export type NetworkProvideResponseResult = BidiEmptyResult;
export interface NetworkRemoveDataCollectorParameters { collector: NetworkCollector }
export type NetworkRemoveDataCollectorResult = BidiEmptyResult;
export interface NetworkRemoveInterceptParameters { intercept: NetworkIntercept }
export type NetworkRemoveInterceptResult = BidiEmptyResult;
export interface NetworkSetCacheBehaviorParameters { cacheBehavior: "default" | "bypass"; contexts?: BrowsingContextId[] }
export type NetworkSetCacheBehaviorResult = BidiEmptyResult;
export interface NetworkSetExtraHeadersParameters { headers: NetworkHeader[]; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[] }
export type NetworkSetExtraHeadersResult = BidiEmptyResult;

export interface NetworkAuthRequiredParameters extends NetworkBaseParameters { response: NetworkResponseData }
export interface NetworkBeforeRequestSentParameters extends NetworkBaseParameters { initiator?: NetworkInitiator }
export interface NetworkFetchErrorParameters extends NetworkBaseParameters { errorText: string }
export interface NetworkResponseCompletedParameters extends NetworkBaseParameters { response: NetworkResponseData }
export interface NetworkResponseStartedParameters extends NetworkBaseParameters { response: NetworkResponseData }

// --- storage module ------------------------------------------------------

export interface StoragePartitionKey extends BidiExtensible { userContext?: string; sourceOrigin?: string }
export interface StorageCookieFilter extends BidiExtensible {
  name?: string; value?: NetworkBytesValue; domain?: string; path?: string; size?: BidiJsUint;
  httpOnly?: boolean; secure?: boolean; sameSite?: NetworkSameSite; expiry?: BidiJsUint;
}
export interface StorageBrowsingContextPartitionDescriptor { type: "context"; context: BrowsingContextId }
export interface StorageStorageKeyPartitionDescriptor extends BidiExtensible { type: "storageKey"; userContext?: string; sourceOrigin?: string }
export type StoragePartitionDescriptor = StorageBrowsingContextPartitionDescriptor | StorageStorageKeyPartitionDescriptor;

export interface StorageGetCookiesParameters { filter?: StorageCookieFilter; partition?: StoragePartitionDescriptor }
export interface StorageGetCookiesResult { cookies: NetworkCookie[]; partitionKey: StoragePartitionKey }
export interface StoragePartialCookie extends BidiExtensible {
  name: string; value: NetworkBytesValue; domain: string; path?: string; httpOnly?: boolean;
  secure?: boolean; sameSite?: NetworkSameSite; expiry?: BidiJsUint;
}
export interface StorageSetCookieParameters { cookie: StoragePartialCookie; partition?: StoragePartitionDescriptor }
export interface StorageSetCookieResult { partitionKey: StoragePartitionKey }
export interface StorageDeleteCookiesParameters { filter?: StorageCookieFilter; partition?: StoragePartitionDescriptor }
export interface StorageDeleteCookiesResult { partitionKey: StoragePartitionKey }

// --- log module ------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";
interface LogBaseLogEntry { level: LogLevel; source: ScriptSource; text: string | null; timestamp: BidiJsUint; stackTrace?: ScriptStackTrace }
export interface LogGenericLogEntry extends LogBaseLogEntry { type: string }
export interface LogConsoleLogEntry extends LogBaseLogEntry { type: "console"; method: string; args: ScriptRemoteValue[] }
export interface LogJavascriptLogEntry extends LogBaseLogEntry { type: "javascript" }
export type LogEntry = LogGenericLogEntry | LogConsoleLogEntry | LogJavascriptLogEntry;

// --- emulation module ----------------------------------------------------

export type EmulationForcedColorsModeTheme = "light" | "dark";
/** Firefox 153: not implemented. */
export interface EmulationSetForcedColorsModeThemeOverrideParameters {
  theme: EmulationForcedColorsModeTheme | null; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[];
}
export type EmulationSetForcedColorsModeThemeOverrideResult = BidiEmptyResult;

export interface EmulationGeolocationCoordinates {
  latitude: number /* -90.0..90.0 */; longitude: number /* -180.0..180.0 */; accuracy?: number /* .ge 0.0 default 1.0 */;
  altitude?: number | null; altitudeAccuracy?: number | null; heading?: number | null /* 0.0..360.0 */; speed?: number | null;
}
export interface EmulationGeolocationPositionError { type: "positionUnavailable" }
/**
 * The params group is `(coordinates / error)`, an untagged either-or (no
 * literal discriminant field), not a discriminated union in the usual sense.
 */
export type EmulationSetGeolocationOverrideParameters = { contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[] } & (
  | { coordinates: EmulationGeolocationCoordinates | null } | { error: EmulationGeolocationPositionError }
);
export type EmulationSetGeolocationOverrideResult = BidiEmptyResult;

export interface EmulationSetLocaleOverrideParameters { locale: string | null; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[] }
export type EmulationSetLocaleOverrideResult = BidiEmptyResult;

export interface EmulationMediaFeature { name: string; value: string }
/** Firefox 153: not implemented. */
export interface EmulationSetMediaFeaturesOverrideParameters {
  features: EmulationMediaFeature[] | null; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[];
}
export type EmulationSetMediaFeaturesOverrideResult = BidiEmptyResult;

/** Spec currently defines only the "offline" variant; kept as its own tagged shape for future growth. */
export interface EmulationNetworkConditionsOffline { type: "offline" }
export type EmulationNetworkConditions = EmulationNetworkConditionsOffline;
export interface EmulationSetNetworkConditionsParameters {
  networkConditions: EmulationNetworkConditions | null; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[];
}
export type EmulationSetNetworkConditionsResult = BidiEmptyResult;

export interface EmulationScreenArea { width: BidiJsUint; height: BidiJsUint }
export interface EmulationSetScreenSettingsOverrideParameters {
  screenArea: EmulationScreenArea | null; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[];
}
export type EmulationSetScreenSettingsOverrideResult = BidiEmptyResult;

export type EmulationScreenOrientationNatural = "portrait" | "landscape";
export type EmulationScreenOrientationType = "portrait-primary" | "portrait-secondary" | "landscape-primary" | "landscape-secondary";
export interface EmulationScreenOrientation { natural: EmulationScreenOrientationNatural; type: EmulationScreenOrientationType }
export interface EmulationSetScreenOrientationOverrideParameters {
  screenOrientation: EmulationScreenOrientation | null; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[];
}
export type EmulationSetScreenOrientationOverrideResult = BidiEmptyResult;

export interface EmulationSetUserAgentOverrideParameters { userAgent: string | null; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[] }
export type EmulationSetUserAgentOverrideResult = BidiEmptyResult;

/** Firefox 153: not implemented. */
export interface EmulationSetViewportMetaOverrideParameters { viewportMeta: true | null; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[] }
export type EmulationSetViewportMetaOverrideResult = BidiEmptyResult;

/** Firefox 153: not implemented. */
export interface EmulationSetScriptingEnabledParameters { enabled: false | null; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[] }
export type EmulationSetScriptingEnabledResult = BidiEmptyResult;

/** Firefox 153: not implemented. */
export interface EmulationSetScrollbarTypeOverrideParameters {
  scrollbarType: "classic" | "overlay" | null; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[];
}
export type EmulationSetScrollbarTypeOverrideResult = BidiEmptyResult;

export interface EmulationSetTimezoneOverrideParameters { timezone: string | null; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[] }
export type EmulationSetTimezoneOverrideResult = BidiEmptyResult;

/** Firefox 153: not implemented. */
export interface EmulationSetTouchOverrideParameters {
  maxTouchPoints: BidiJsUint | null /* .ge 1 */; contexts?: BrowsingContextId[]; userContexts?: BrowserUserContext[];
}
export type EmulationSetTouchOverrideResult = BidiEmptyResult;

// --- BidiCommands: method name -> {params, result}. The transport's generic hook.

export interface BidiCommands {
  "session.status": { params: BidiEmptyParams; result: SessionStatusResult };
  "session.new": { params: SessionNewParameters; result: SessionNewResult };
  "session.end": { params: BidiEmptyParams; result: BidiEmptyResult };
  "session.subscribe": { params: SessionSubscribeParameters; result: SessionSubscribeResult };
  "session.unsubscribe": { params: SessionUnsubscribeParameters; result: BidiEmptyResult };

  "browsingContext.activate": { params: BrowsingContextActivateParameters; result: BrowsingContextActivateResult };
  "browsingContext.captureScreenshot": { params: BrowsingContextCaptureScreenshotParameters; result: BrowsingContextCaptureScreenshotResult };
  "browsingContext.close": { params: BrowsingContextCloseParameters; result: BrowsingContextCloseResult };
  "browsingContext.create": { params: BrowsingContextCreateParameters; result: BrowsingContextCreateResult };
  "browsingContext.getTree": { params: BrowsingContextGetTreeParameters; result: BrowsingContextGetTreeResult };
  "browsingContext.handleUserPrompt": { params: BrowsingContextHandleUserPromptParameters; result: BrowsingContextHandleUserPromptResult };
  "browsingContext.locateNodes": { params: BrowsingContextLocateNodesParameters; result: BrowsingContextLocateNodesResult };
  "browsingContext.navigate": { params: BrowsingContextNavigateParameters; result: BrowsingContextNavigateResult };
  "browsingContext.print": { params: BrowsingContextPrintParameters; result: BrowsingContextPrintResult };
  "browsingContext.reload": { params: BrowsingContextReloadParameters; result: BrowsingContextReloadResult };
  /** Firefox 153: not implemented. */
  "browsingContext.setBypassCSP": { params: BrowsingContextSetBypassCSPParameters; result: BrowsingContextSetBypassCSPResult };
  "browsingContext.setViewport": { params: BrowsingContextSetViewportParameters; result: BrowsingContextSetViewportResult };
  /** Firefox 153: not implemented. */
  "browsingContext.startScreencast": { params: BrowsingContextStartScreencastParameters; result: BrowsingContextStartScreencastResult };
  /** Firefox 153: not implemented. */
  "browsingContext.stopScreencast": { params: BrowsingContextStopScreencastParameters; result: BrowsingContextStopScreencastResult };
  "browsingContext.traverseHistory": { params: BrowsingContextTraverseHistoryParameters; result: BrowsingContextTraverseHistoryResult };

  "script.addPreloadScript": { params: ScriptAddPreloadScriptParameters; result: ScriptAddPreloadScriptResult };
  "script.callFunction": { params: ScriptCallFunctionParameters; result: ScriptCallFunctionResult };
  "script.disown": { params: ScriptDisownParameters; result: ScriptDisownResult };
  "script.evaluate": { params: ScriptEvaluateParameters; result: ScriptEvaluateResult };
  "script.getRealms": { params: ScriptGetRealmsParameters; result: ScriptGetRealmsResult };
  "script.removePreloadScript": { params: ScriptRemovePreloadScriptParameters; result: ScriptRemovePreloadScriptResult };

  "input.performActions": { params: InputPerformActionsParameters; result: InputPerformActionsResult };
  "input.releaseActions": { params: InputReleaseActionsParameters; result: InputReleaseActionsResult };
  "input.setFiles": { params: InputSetFilesParameters; result: InputSetFilesResult };

  "network.addDataCollector": { params: NetworkAddDataCollectorParameters; result: NetworkAddDataCollectorResult };
  "network.addIntercept": { params: NetworkAddInterceptParameters; result: NetworkAddInterceptResult };
  "network.continueRequest": { params: NetworkContinueRequestParameters; result: NetworkContinueRequestResult };
  "network.continueResponse": { params: NetworkContinueResponseParameters; result: NetworkContinueResponseResult };
  "network.continueWithAuth": { params: NetworkContinueWithAuthParameters; result: NetworkContinueWithAuthResult };
  "network.disownData": { params: NetworkDisownDataParameters; result: NetworkDisownDataResult };
  "network.failRequest": { params: NetworkFailRequestParameters; result: NetworkFailRequestResult };
  "network.getData": { params: NetworkGetDataParameters; result: NetworkGetDataResult };
  "network.provideResponse": { params: NetworkProvideResponseParameters; result: NetworkProvideResponseResult };
  "network.removeDataCollector": { params: NetworkRemoveDataCollectorParameters; result: NetworkRemoveDataCollectorResult };
  "network.removeIntercept": { params: NetworkRemoveInterceptParameters; result: NetworkRemoveInterceptResult };
  "network.setCacheBehavior": { params: NetworkSetCacheBehaviorParameters; result: NetworkSetCacheBehaviorResult };
  "network.setExtraHeaders": { params: NetworkSetExtraHeadersParameters; result: NetworkSetExtraHeadersResult };

  "storage.deleteCookies": { params: StorageDeleteCookiesParameters; result: StorageDeleteCookiesResult };
  "storage.getCookies": { params: StorageGetCookiesParameters; result: StorageGetCookiesResult };
  "storage.setCookie": { params: StorageSetCookieParameters; result: StorageSetCookieResult };

  /** Firefox 153: not implemented. */
  "emulation.setForcedColorsModeThemeOverride": { params: EmulationSetForcedColorsModeThemeOverrideParameters; result: EmulationSetForcedColorsModeThemeOverrideResult };
  "emulation.setGeolocationOverride": { params: EmulationSetGeolocationOverrideParameters; result: EmulationSetGeolocationOverrideResult };
  "emulation.setLocaleOverride": { params: EmulationSetLocaleOverrideParameters; result: EmulationSetLocaleOverrideResult };
  /** Firefox 153: not implemented. */
  "emulation.setMediaFeaturesOverride": { params: EmulationSetMediaFeaturesOverrideParameters; result: EmulationSetMediaFeaturesOverrideResult };
  "emulation.setNetworkConditions": { params: EmulationSetNetworkConditionsParameters; result: EmulationSetNetworkConditionsResult };
  "emulation.setScreenOrientationOverride": { params: EmulationSetScreenOrientationOverrideParameters; result: EmulationSetScreenOrientationOverrideResult };
  "emulation.setScreenSettingsOverride": { params: EmulationSetScreenSettingsOverrideParameters; result: EmulationSetScreenSettingsOverrideResult };
  /** Firefox 153: not implemented. */
  "emulation.setScriptingEnabled": { params: EmulationSetScriptingEnabledParameters; result: EmulationSetScriptingEnabledResult };
  /** Firefox 153: not implemented. */
  "emulation.setScrollbarTypeOverride": { params: EmulationSetScrollbarTypeOverrideParameters; result: EmulationSetScrollbarTypeOverrideResult };
  "emulation.setTimezoneOverride": { params: EmulationSetTimezoneOverrideParameters; result: EmulationSetTimezoneOverrideResult };
  /** Firefox 153: not implemented. */
  "emulation.setTouchOverride": { params: EmulationSetTouchOverrideParameters; result: EmulationSetTouchOverrideResult };
  "emulation.setUserAgentOverride": { params: EmulationSetUserAgentOverrideParameters; result: EmulationSetUserAgentOverrideResult };
  /** Firefox 153: not implemented. */
  "emulation.setViewportMetaOverride": { params: EmulationSetViewportMetaOverrideParameters; result: EmulationSetViewportMetaOverrideResult };
}
export type BidiMethod = keyof BidiCommands;

// --- BidiEvents: event name -> params. The subscribe side's generic hook.

export interface BidiEvents {
  "browsingContext.contextCreated": BrowsingContextInfo;
  "browsingContext.contextDestroyed": BrowsingContextInfo;
  "browsingContext.navigationStarted": BrowsingContextNavigationInfo;
  "browsingContext.fragmentNavigated": BrowsingContextNavigationInfo;
  "browsingContext.historyUpdated": BrowsingContextHistoryUpdatedParameters;
  "browsingContext.domContentLoaded": BrowsingContextNavigationInfo;
  "browsingContext.load": BrowsingContextNavigationInfo;
  "browsingContext.downloadWillBegin": BrowsingContextDownloadWillBeginParams;
  "browsingContext.downloadEnd": BrowsingContextDownloadEndParams;
  "browsingContext.navigationAborted": BrowsingContextNavigationInfo;
  "browsingContext.navigationCommitted": BrowsingContextNavigationInfo;
  "browsingContext.navigationFailed": BrowsingContextNavigationInfo;
  "browsingContext.userPromptClosed": BrowsingContextUserPromptClosedParameters;
  "browsingContext.userPromptOpened": BrowsingContextUserPromptOpenedParameters;

  "script.message": ScriptMessageParameters;
  "script.realmCreated": ScriptRealmInfo;
  "script.realmDestroyed": ScriptRealmDestroyedParameters;

  "input.fileDialogOpened": InputFileDialogInfo;

  "network.authRequired": NetworkAuthRequiredParameters;
  "network.beforeRequestSent": NetworkBeforeRequestSentParameters;
  "network.fetchError": NetworkFetchErrorParameters;
  "network.responseCompleted": NetworkResponseCompletedParameters;
  "network.responseStarted": NetworkResponseStartedParameters;

  "log.entryAdded": LogEntry;
}
export type BidiEventName = keyof BidiEvents;
