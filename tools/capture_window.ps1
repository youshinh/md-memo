# tools/capture_window.ps1
# High-fidelity DirectComposition / WebView2 window capture using PrintWindow API
param(
    [string]$WindowTitle = "MD-Memo",
    [string]$OutputFile = "test.png"
)

$code = @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class WindowCapturer {
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public static bool Capture(string windowTitle, string outputPath) {
        IntPtr hwnd = FindWindow(null, windowTitle);
        if (hwnd == IntPtr.Zero) {
            Console.WriteLine("Window not found: " + windowTitle);
            return false;
        }

        SetForegroundWindow(hwnd);
        System.Threading.Thread.Sleep(150);

        RECT rect;
        GetWindowRect(hwnd, out rect);
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) {
            Console.WriteLine("Invalid window size: " + width + "x" + height);
            return false;
        }

        using (Bitmap bmp = new Bitmap(width, height)) {
            using (Graphics g = Graphics.FromImage(bmp)) {
                IntPtr hdc = g.GetHdc();
                try {
                    // PW_RENDERFULLCONTENT = 2 for DWM / DirectComposition hardware acceleration
                    bool success = PrintWindow(hwnd, hdc, 2);
                    if (!success) {
                        success = PrintWindow(hwnd, hdc, 0);
                    }
                    if (!success) {
                        Console.WriteLine("PrintWindow returned false");
                        return false;
                    }
                } finally {
                    g.ReleaseHdc(hdc);
                }
            }
            bmp.Save(outputPath, ImageFormat.Png);
            Console.WriteLine("Successfully captured to " + outputPath);
            return true;
        }
    }
}
"@

Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing

$res = [WindowCapturer]::Capture($WindowTitle, $OutputFile)
if (!$res) {
    exit 1
}
exit 0
