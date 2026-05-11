import structlog

_configured = False


def configure_logging() -> None:
    global _configured
    if _configured:
        return
    structlog.configure(
        processors=[
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.BoundLogger,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
    _configured = True


def get_logger(agent: str) -> structlog.BoundLogger:
    configure_logging()
    return structlog.get_logger().bind(agent=agent)
