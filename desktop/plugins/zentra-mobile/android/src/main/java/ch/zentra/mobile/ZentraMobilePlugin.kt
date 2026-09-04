package ch.zentra.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.util.UUID

@InvokeArg class ShareArgs { lateinit var path: String }
@InvokeArg class UrlArgs { lateinit var url: String }
class ZentraFileProvider: FileProvider()

@TauriPlugin
class ZentraMobilePlugin(private val activity: Activity): Plugin(activity) {
    @Command fun fileName(invoke: Invoke) {
        val args = invoke.parseArgs(UrlArgs::class.java)
        val uri = Uri.parse(args.url)
        if (uri.scheme != "content") { invoke.reject("Document refusé"); return }
        try {
            val name = activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            } ?: "document"
            val result = app.tauri.plugin.JSObject()
            result.put("name", name)
            invoke.resolve(result)
        } catch (error: Exception) { invoke.reject("Nom du document indisponible") }
    }
    @Command fun shareFile(invoke: Invoke) {
        val args = invoke.parseArgs(ShareArgs::class.java)
        // Copy outside the UI thread. Only private app files may be exported.
        Thread {
            try {
                val source = File(args.path).canonicalFile
                // Tauri stores its managed folders directly under applicationInfo.dataDir.
                // Keep the database and protected installation identity outside this allowlist.
                val dataRoot = File(activity.applicationInfo.dataDir)
                val roots = listOf(
                    activity.filesDir, activity.cacheDir, activity.noBackupFilesDir,
                    File(dataRoot, "attachments"), File(dataRoot, "exports"), File(dataRoot, "backups")
                ).map { it.canonicalPath + File.separator }
                require(source.isFile && roots.any { source.path.startsWith(it) }) { "Chemin de document refusé" }
                val root = File(activity.cacheDir, "zentra-share").apply { mkdirs() }
                root.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86400000 }?.forEach { it.deleteRecursively() }
                val folder = File(root, UUID.randomUUID().toString()).apply { mkdirs() }
                val copy = File(folder, source.name)
                source.inputStream().use { input -> copy.outputStream().use { output -> input.copyTo(output) } }
                val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.zentra.files", copy)
                val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(copy.extension.lowercase()) ?: "application/octet-stream"
                activity.runOnUiThread {
                    try {
                        val intent = Intent(Intent.ACTION_SEND).apply {
                            type = mime
                            putExtra(Intent.EXTRA_STREAM, uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            clipData = android.content.ClipData.newRawUri(copy.name, uri)
                        }
                        activity.startActivity(Intent.createChooser(intent, "Enregistrer ou partager"))
                        invoke.resolve()
                    } catch (error: Exception) { invoke.reject("Impossible d’ouvrir le partage de documents") }
                }
            } catch (error: Exception) { invoke.reject("Ce document ne peut pas être partagé") }
        }.start()
    }

    @Command fun openUrl(invoke: Invoke) {
        val args = invoke.parseArgs(UrlArgs::class.java)
        val uri = Uri.parse(args.url)
        if (uri.scheme != "https" && uri.scheme != "mailto") { invoke.reject("Adresse refusée"); return }
        activity.runOnUiThread {
            try { activity.startActivity(Intent(Intent.ACTION_VIEW, uri)); invoke.resolve() }
            catch (error: Exception) { invoke.reject("Aucune application compatible n’est disponible") }
        }
    }
}
