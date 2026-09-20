// Screen region capture for the character tab's live sync, which reads an addon's
// pixel strip off the running game. Windows only: Chromium's capture APIs are not
// available to the app's chrome-extension:// page, so frames come from GDI instead.
//
// capture(x, y, width, height) -> { width, height, data: Buffer } in RGBA order
// virtualScreen()              -> { x, y, width, height, dpiAware } bounds of all displays

#include <napi.h>

#ifdef _WIN32
#include <windows.h>

// The app is only system-DPI-aware, so Windows virtualises GDI for it: on a display
// running above 100% scaling both the screen metrics and BitBlt come back shrunk to
// the scaled size, and the captured image is a resampled copy rather than the real
// pixels. Making just this thread per-monitor-aware for the duration of a call gets
// the true pixels, which keeps the addon's strip crisp and lets it be much smaller.
//
// Resolved at runtime so the addon still builds and runs where the call is missing
// (before Windows 10 1607), where captures stay scaled but otherwise work.
#ifndef DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
#define DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 ((HANDLE) -4)
#endif

typedef HANDLE (WINAPI* SetThreadDpiAwarenessContextFn)(HANDLE);

// restores the thread's previous awareness however we leave the scope
struct ThreadDpiAwareness {
	SetThreadDpiAwarenessContextFn setter = nullptr;
	HANDLE previous = nullptr;

	ThreadDpiAwareness() {
		HMODULE user32 = GetModuleHandleW(L"user32.dll");
		if (user32 != nullptr)
			setter = reinterpret_cast<SetThreadDpiAwarenessContextFn>(GetProcAddress(user32, "SetThreadDpiAwarenessContext"));

		if (setter != nullptr)
			previous = setter(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
	}

	bool active() const {
		return setter != nullptr && previous != nullptr;
	}

	~ThreadDpiAwareness() {
		if (setter != nullptr && previous != nullptr)
			setter(previous);
	}
};

// releases the device contexts and bitmap however we leave the function
struct CaptureResources {
	HDC screen = nullptr;
	HDC memory = nullptr;
	HBITMAP bitmap = nullptr;
	HGDIOBJ previous = nullptr;

	~CaptureResources() {
		if (memory != nullptr) {
			if (previous != nullptr)
				SelectObject(memory, previous);

			DeleteDC(memory);
		}

		if (bitmap != nullptr)
			DeleteObject(bitmap);

		if (screen != nullptr)
			ReleaseDC(nullptr, screen);
	}
};

Napi::Value Capture(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();

	if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsNumber()) {
		Napi::TypeError::New(env, "capture(x, y, width, height) expects four numbers").ThrowAsJavaScriptException();
		return env.Null();
	}

	const int x = info[0].As<Napi::Number>().Int32Value();
	const int y = info[1].As<Napi::Number>().Int32Value();
	const int width = info[2].As<Napi::Number>().Int32Value();
	const int height = info[3].As<Napi::Number>().Int32Value();

	if (width <= 0 || height <= 0) {
		Napi::RangeError::New(env, "capture width and height must be positive").ThrowAsJavaScriptException();
		return env.Null();
	}

	// physical pixels, matching the coordinates virtualScreen() reports
	ThreadDpiAwareness dpi;

	CaptureResources res;
	res.screen = GetDC(nullptr);
	if (res.screen == nullptr) {
		Napi::Error::New(env, "could not get a device context for the screen").ThrowAsJavaScriptException();
		return env.Null();
	}

	res.memory = CreateCompatibleDC(res.screen);
	if (res.memory == nullptr) {
		Napi::Error::New(env, "could not create a memory device context").ThrowAsJavaScriptException();
		return env.Null();
	}

	res.bitmap = CreateCompatibleBitmap(res.screen, width, height);
	if (res.bitmap == nullptr) {
		Napi::Error::New(env, "could not create a bitmap for the capture").ThrowAsJavaScriptException();
		return env.Null();
	}

	res.previous = SelectObject(res.memory, res.bitmap);

	// CAPTUREBLT includes layered windows, which is what most overlays are
	if (!BitBlt(res.memory, 0, 0, width, height, res.screen, x, y, SRCCOPY | CAPTUREBLT)) {
		Napi::Error::New(env, "screen capture failed").ThrowAsJavaScriptException();
		return env.Null();
	}

	BITMAPINFO bmi = {};
	bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
	bmi.bmiHeader.biWidth = width;
	bmi.bmiHeader.biHeight = -height; // negative: top-down rows, as canvas expects
	bmi.bmiHeader.biPlanes = 1;
	bmi.bmiHeader.biBitCount = 32;
	bmi.bmiHeader.biCompression = BI_RGB;

	const size_t byte_length = static_cast<size_t>(width) * height * 4;
	Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::New(env, byte_length);

	if (GetDIBits(res.memory, res.bitmap, 0, height, buffer.Data(), &bmi, DIB_RGB_COLORS) == 0) {
		Napi::Error::New(env, "could not read the captured pixels").ThrowAsJavaScriptException();
		return env.Null();
	}

	// GDI gives BGRA with an unused alpha byte; swap to RGBA and make it opaque
	uint8_t* pixels = buffer.Data();
	for (size_t i = 0; i < byte_length; i += 4) {
		const uint8_t blue = pixels[i];
		pixels[i] = pixels[i + 2];
		pixels[i + 2] = blue;
		pixels[i + 3] = 255;
	}

	Napi::Object result = Napi::Object::New(env);
	result.Set("width", Napi::Number::New(env, width));
	result.Set("height", Napi::Number::New(env, height));
	result.Set("data", buffer);
	return result;
}

Napi::Value VirtualScreen(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();

	ThreadDpiAwareness dpi;

	Napi::Object result = Napi::Object::New(env);
	result.Set("x", Napi::Number::New(env, GetSystemMetrics(SM_XVIRTUALSCREEN)));
	result.Set("y", Napi::Number::New(env, GetSystemMetrics(SM_YVIRTUALSCREEN)));
	result.Set("width", Napi::Number::New(env, GetSystemMetrics(SM_CXVIRTUALSCREEN)));
	result.Set("height", Napi::Number::New(env, GetSystemMetrics(SM_CYVIRTUALSCREEN)));
	result.Set("dpiAware", Napi::Boolean::New(env, dpi.active()));
	return result;
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
	return Napi::Boolean::New(info.Env(), true);
}

#else

Napi::Value Capture(const Napi::CallbackInfo& info) {
	Napi::Error::New(info.Env(), "screen capture is only implemented on windows").ThrowAsJavaScriptException();
	return info.Env().Null();
}

Napi::Value VirtualScreen(const Napi::CallbackInfo& info) {
	Napi::Error::New(info.Env(), "screen capture is only implemented on windows").ThrowAsJavaScriptException();
	return info.Env().Null();
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
	return Napi::Boolean::New(info.Env(), false);
}

#endif

Napi::Object Init(Napi::Env env, Napi::Object exports) {
	exports.Set("capture", Napi::Function::New(env, Capture));
	exports.Set("virtualScreen", Napi::Function::New(env, VirtualScreen));
	exports.Set("isSupported", Napi::Function::New(env, IsSupported));
	return exports;
}

NODE_API_MODULE(screencap, Init)
