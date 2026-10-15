package com.example.shaderharness

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RuntimeShader
import android.os.Build
import android.view.Choreographer
import android.view.View
import androidx.annotation.RequiresApi

/** API 33+. Copy the exported .agsl file to app/src/main/assets/weather.agsl. */
@RequiresApi(Build.VERSION_CODES.TIRAMISU)
class WeatherShaderView(context: Context) : View(context), Choreographer.FrameCallback {
    // Compilation happens here; an invalid AGSL file throws IllegalArgumentException.
    private val runtimeShader = RuntimeShader(context.assets.open("weather.agsl").bufferedReader().use { it.readText() })
    private val paint = Paint().apply { shader = runtimeShader }
    private var firstFrame = 0L
    private var elapsed = 0f

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        firstFrame = 0L
        Choreographer.getInstance().postFrameCallback(this)
    }

    override fun onDetachedFromWindow() {
        Choreographer.getInstance().removeFrameCallback(this)
        super.onDetachedFromWindow()
    }

    override fun doFrame(frameTimeNanos: Long) {
        if (!isAttachedToWindow) return
        if (firstFrame == 0L) firstFrame = frameTimeNanos
        elapsed = (frameTimeNanos - firstFrame) / 1_000_000_000f
        invalidate()
        Choreographer.getInstance().postFrameCallback(this)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width == 0 || height == 0) return
        runtimeShader.setFloatUniform("u_resolution", width.toFloat(), height.toFloat())
        runtimeShader.setFloatUniform("u_time", elapsed)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    }
}
