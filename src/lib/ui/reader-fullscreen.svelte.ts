type FullscreenMode = "none" | "native" | "popover" | "fixed";

export class ReaderFullscreenController {
	active = $state(false);
	#mode: FullscreenMode = "none";
	#host: HTMLElement | null = null;
	#shell: HTMLElement | null = null;
	#button: HTMLElement | null = null;
	#focusTarget: HTMLElement | null = null;
	#document: Document | null = null;
	#attachmentId = 0;
	#onFullscreenChange = (): void => this.#syncNativeFullscreen();
	#onPopoverToggle = (event: Event): void => this.#syncPopover(event);
	#onKeydown = (event: KeyboardEvent): void => {
		if (event.key === "Escape" && (this.#mode === "fixed" || this.#mode === "popover")) {
			event.preventDefault();
			void this.close();
		}
	};

	attach(host: HTMLElement, shell: HTMLElement, button: HTMLElement): () => void {
		this.#attachmentId += 1;
		this.#host = host;
		this.#shell = shell;
		this.#button = button;
		this.#document = host.ownerDocument;
		this.#document.addEventListener("fullscreenchange", this.#onFullscreenChange);
		this.#document.addEventListener("keydown", this.#onKeydown);
		shell.addEventListener("toggle", this.#onPopoverToggle);
		this.#syncNativeFullscreen();
		return () => this.detach();
	}

	async toggle(): Promise<void> {
		if (this.active) {
			await this.close();
			return;
		}

		const host = this.#host;
		const ownerDocument = this.#document;
		if (host === null || ownerDocument === null) return;
		const attachmentId = this.#attachmentId;
		this.#focusTarget = this.#button;
		if (typeof host.requestFullscreen === "function") {
			try {
				await host.requestFullscreen({ navigationUI: "hide" });
			} catch {
				// A denied native request falls through to the top-layer popover.
			}
			if (
				attachmentId !== this.#attachmentId ||
				this.#host !== host ||
				this.#document !== ownerDocument
			) {
				if (ownerDocument.fullscreenElement === host) {
					try {
						await ownerDocument.exitFullscreen();
					} catch {
						// The detached host may already be leaving fullscreen.
					}
				}
				return;
			}
			if (ownerDocument.fullscreenElement === host) {
				this.#mode = "native";
				this.active = true;
				return;
			}
		}
		this.#openFallback();
	}

	async close(): Promise<void> {
		if (this.#mode === "native" && this.#document?.fullscreenElement === this.#host) {
			try {
				await this.#document.exitFullscreen();
			} catch {
				this.#finish();
			}
			return;
		}
		if (this.#mode === "popover" && this.#shell?.matches(":popover-open")) {
			this.#shell.hidePopover();
			return;
		}
		this.#closeFallback();
	}

	detach(): void {
		const ownerDocument = this.#document;
		const host = this.#host;
		const exitNativeFullscreen =
			this.#mode === "native" && ownerDocument?.fullscreenElement === host;
		this.#attachmentId += 1;
		this.#document?.removeEventListener("fullscreenchange", this.#onFullscreenChange);
		this.#document?.removeEventListener("keydown", this.#onKeydown);
		this.#shell?.removeEventListener("toggle", this.#onPopoverToggle);
		if (this.#mode === "popover" && this.#shell?.matches(":popover-open")) {
			this.#shell.hidePopover();
		}
		this.#shell?.removeAttribute("popover");
		this.#host?.removeAttribute("data-fullscreen-fallback");
		this.#mode = "none";
		this.active = false;
		this.#host = null;
		this.#shell = null;
		this.#button = null;
		this.#focusTarget = null;
		this.#document = null;
		if (exitNativeFullscreen && ownerDocument !== null) {
			void ownerDocument.exitFullscreen().catch(() => undefined);
		}
	}

	#openFallback(): void {
		const shell = this.#shell;
		const host = this.#host;
		if (shell === null || host === null) return;
		host.setAttribute("data-fullscreen-fallback", "");
		try {
			if (typeof shell.showPopover === "function") {
				shell.setAttribute("popover", "manual");
				shell.showPopover();
				this.#mode = "popover";
				this.active = true;
				return;
			}
		} catch {
			// The host-level fixed-position fallback covers browsers with a broken popover layer.
		}
		shell.removeAttribute("popover");
		this.#mode = "fixed";
		this.active = true;
	}

	#closeFallback(): void {
		if (this.#mode === "popover" && this.#shell?.matches(":popover-open")) {
			this.#shell.hidePopover();
		}
		this.#shell?.removeAttribute("popover");
		this.#host?.removeAttribute("data-fullscreen-fallback");
		this.#finish();
	}

	#syncNativeFullscreen(): void {
		if (this.#document?.fullscreenElement === this.#host && this.#host !== null) {
			this.#mode = "native";
			this.active = true;
			return;
		}
		if (this.#mode === "native") this.#finish();
	}

	#syncPopover(event: Event): void {
		const toggleEvent = event as ToggleEvent;
		if (toggleEvent.newState === "open") {
			this.#mode = "popover";
			this.active = true;
		} else if (this.#mode === "popover") {
			this.#finish();
		}
	}

	#finish(): void {
		this.#host?.removeAttribute("data-fullscreen-fallback");
		this.#shell?.removeAttribute("popover");
		this.#mode = "none";
		this.active = false;
		const focusTarget = this.#focusTarget;
		this.#focusTarget = null;
		if (focusTarget?.isConnected) requestAnimationFrame(() => focusTarget.focus());
	}
}
