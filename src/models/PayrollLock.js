module.exports = (sequelize, DataTypes) => {
  const PayrollLock = sequelize.define(
    'PayrollLock',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      period_start: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      period_end: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('locked', 'unlocked'),
        defaultValue: 'locked',
      },
      locked_by: DataTypes.UUID,
      locked_at: DataTypes.DATE,
      notes: DataTypes.TEXT,
    },
    {
      tableName: 'payroll_locks',
      paranoid: true,
      underscored: true,
      indexes: [
        { fields: ['org_id', 'period_start', 'period_end'], unique: true },
        { fields: ['org_id', 'status'] },
      ],
    }
  );

  PayrollLock.associate = (models) => {
    PayrollLock.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    PayrollLock.belongsTo(models.Employee, { foreignKey: 'locked_by', as: 'lockedBy' });
  };

  return PayrollLock;
};
