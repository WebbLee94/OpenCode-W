import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen bg-gray-50">
          <div className="text-center max-w-md p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-2">页面渲染出错</h2>
            <p className="text-sm text-gray-500 mb-4 break-all">
              {this.state.error?.message || '未知错误'}
            </p>
            <button
              onClick={this.handleReset}
              className="px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors text-sm"
            >
              重试
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
