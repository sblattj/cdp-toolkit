/**
 * CDP_DENY_FOCUS: a machine-level switch that stops every tab raise, even an explicit one.
 *
 * Since 3.4.0 nothing raises a tab implicitly, but three opt-ins still can: new_page / claim_page
 * focus:true (foreground Target.createTarget), select_page focus:true (Target.activateTarget) and
 * screencast bringToFront:true (Page.bringToFront). An agent told by a hint or a skill to "use
 * focus:true" then pulls the shared browser over whatever the user is doing. With
 * CDP_DENY_FOCUS=1 those requests are downgraded to the background path and the result says
 * focusDenied:true where the tool has a result to say it in. Default off. Read per call so tests
 * can flip it.
 */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function focusDenied(): boolean {
  return TRUTHY.has((process.env.CDP_DENY_FOCUS ?? "").trim().toLowerCase());
}
