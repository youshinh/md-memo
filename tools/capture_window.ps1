# tools/capture_window.ps1
# High-fidelity DirectComposition / WebView2 window capture with normalized target resolution
param(
    [string]$WindowTitle = "MD-Memo",
    [string]$OutputFile = "test.png",
    [int]$TargetWidth = 1120,
    [int]$TargetHeight = 720
)

$code = @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
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

    public static bool Capture(string windowTitle, string outputPath, int targetWidth, int targetHeight) {
        IntPtr hwnd = FindWindow(null, windowTitle);
        if (hwnd == IntPtr.Zero) {
            Console.WriteLine("Window not found: " + windowTitle);
            return false;
        }

        SetForegroundWindow(hwnd);
        System.Threading.Thread.Sleep(200);

        RECT rect;
        GetWindowRect(hwnd, out rect);
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) {
            Console.WriteLine("Invalid window size: " + width + "x" + height);
            return false;
        }

        using (Bitmap rawBmp = new Bitmap(width, height)) {
            using (Graphics g = Graphics.FromImage(rawBmp)) {
                IntPtr hdc = g.GetHdc();
                try {
                    // PW_RENDERFULLCONTENT = 2 for DWM / DirectComposition
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

            // If targetWidth/targetHeight are specified, resize to exact normalized resolution
            if (targetWidth > 0 && targetHeight > 0) {
                using (Bitmap finalBmp = new Bitmap(targetWidth, targetHeight, PixelFormat.Format32bppArgb)) {
                    using (Graphics gResized = Graphics.FromImage(finalBmp)) {
                        gResized.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        gResized.SmoothingMode = SmoothingMode.HighQuality;
                        gResized.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        gResized.DrawImage(rawBmp, 0, 0, targetWidth, targetHeight);
                    }
                    finalBmp.Save(outputPath, ImageFormat.Png);
                }
            } else {
                rawBmp.Save(outputPath, ImageFormat.Png);
            }

            Console.WriteLine("Successfully captured to " + outputPath + " (Normalized: " + targetWidth + "x" + targetHeight + ")");
            return true;
        }
    }
}
"@

Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing

$res = [WindowCapturer]::Capture($WindowTitle, $OutputFile, $TargetWidth, $TargetHeight)
if (!$res) {
    exit 1
}
exit 0
