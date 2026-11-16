package app.homecast.playback

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock

/** Accelerometer shake detection for extending the sleep timer (registered only while a timer is active). */
internal class ShakeDetector(context: Context, private val onShake: () -> Unit) : SensorEventListener {
    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private var active = false
    private var lastShake = 0L

    fun start() {
        if (active) return
        val sm = sensors ?: return
        val accel = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
        active = sm.registerListener(this, accel, SensorManager.SENSOR_DELAY_UI)
    }

    fun stop() {
        if (!active) return
        sensors?.unregisterListener(this)
        active = false
    }

    override fun onSensorChanged(event: SensorEvent) {
        val now = SystemClock.elapsedRealtime()
        if (SleepMath.isShake(event.values[0], event.values[1], event.values[2], now, lastShake)) {
            lastShake = now
            onShake()
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
