import Foundation

public enum ShellCommand: String, Sendable {
    case overview, terminal, activity, settings, sidebar, refresh, tray, biggerFont, smallerFont, resetFont, checkForUpdates
    case newProject, newSession, newTab, openPageInBrowser, openFile, saveFile, closePage, findPage, back, forward, nextPage, previousPage, zoomIn, zoomOut, resetZoom
}
