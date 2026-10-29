/** Synchronous guard for continuous camera callbacks and the manual review dialog.
 * React state updates are asynchronous; a ref-backed gate prevents a second decoded
 * symbol from replacing the item that a user is already inspecting.
 */
export class ScanIntakeGate {
  private busy = false;
  private awaitingReview = false;

  begin(): boolean {
    if (this.busy || this.awaitingReview) return false;
    this.busy = true;
    return true;
  }
  requireReview(): void {
    this.awaitingReview = true;
  }
  finish(): void {
    this.busy = false;
  }
  beginReviewedCommit(): boolean {
    if (this.busy || !this.awaitingReview) return false;
    this.busy = true;
    return true;
  }
  completeReview(): void {
    this.awaitingReview = false;
  }
  get hasPendingReview(): boolean {
    return this.awaitingReview;
  }
}
